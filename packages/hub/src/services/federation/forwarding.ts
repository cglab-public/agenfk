import { createHmac } from 'crypto';
import type { DB } from '../../db.js';
import { readParentBinding, type IdentityPolicy } from './parentBinding.js';
import { enqueueOutboxBatch } from './federationSync.js';

/**
 * Forwarding a child hub's events to its parent (CGLAB-184).
 *
 * Two rules, in this order:
 *  1. **Forwarding may never become a condition of the child's own ingest.**
 *     Everything here reports failure as a value. A parent that is down, slow,
 *     misconfigured or hostile must not be able to turn a working /v1/events
 *     into a 500 for a developer who has never heard of it.
 *  2. **The identity policy belongs to the parent.** The child applies what it
 *     is told and stamps that on every row, so switching the policy later
 *     cannot leave one series containing two identity spaces for one person.
 */

/**
 * Resolve the policy actually in force from the group default and the
 * per-child override. A per-child value wins in BOTH directions — it is an
 * override, not an escalation — and anything unrecognised falls back to the
 * default rather than being guessed at.
 */
export function effectiveIdentityPolicy(
  groupDefault: IdentityPolicy | null | undefined,
  childOverride: IdentityPolicy | null | undefined,
): IdentityPolicy {
  const valid = (v: unknown): v is IdentityPolicy => v === 'keep' || v === 'pseudonymize';
  if (valid(childOverride)) return childOverride;
  if (valid(groupDefault)) return groupDefault;
  return 'keep';
}

/**
 * A stable stand-in for a person, per child hub.
 *
 * Keyed on a hub-local secret AND the hub id. The hub id alone would be
 * useless as a key: the parent issued it, and the input space is a company's
 * email addresses, so it could reverse every pseudonym by brute force in
 * milliseconds. Truncated to 64 bits: this is a label in a UI, not a
 * signature.
 */
export function pseudonymFor(childHubId: string, secretKey: string, userKey: string): string {
  const mac = createHmac('sha256', `${secretKey}:${childHubId}`).update(userKey).digest('hex');
  return `anon:${mac.slice(0, 16)}`;
}

/**
 * Payload keys the parent's aggregation actually reads. Under `pseudonymize`
 * the payload is reduced to these rather than filtered for known-bad keys: a
 * deny-list on a free-form blob is a promise nobody can keep, and the fields
 * that matter upstream are a short, known list.
 */
export const FORWARDABLE_PAYLOAD_KEYS = [
  'repo', 'prNumber', 'model', 'harness', 'toStatus', 'leafStory', 'sizingShadow',
  'epic', 'story', 'task', 'bug', 'itemType', 'sizing',
] as const;

/**
 * Strip the identity surface from an event.
 *
 * Rewriting `userKey` alone was cosmetic: `actor.gitEmail` is the field
 * `userKeyFor` DERIVES the key from, so the parent could recompute the
 * plaintext from the very row that claimed to be anonymous. `installationId`
 * is worse — a stable machine id re-joins one person ACROSS child hubs, the
 * exact property the pseudonym exists to prevent. Free text (`itemTitle`) and
 * the payload blob routinely carry names, emails and branch names too.
 */
export function redactIdentity(
  event: Record<string, unknown>,
  childHubId: string,
  secretKey: string,
): Record<string, unknown> {
  const anon = (v: unknown, kind: string) =>
    typeof v === 'string' && v ? pseudonymFor(childHubId, secretKey, `${kind}:${v}`) : null;

  const rawPayload = event.payload;
  const payload: Record<string, unknown> = {};
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    for (const k of FORWARDABLE_PAYLOAD_KEYS) {
      const v = (rawPayload as Record<string, unknown>)[k];
      if (v !== undefined) payload[k] = v;
    }
  }

  const userKey = typeof event.userKey === 'string' ? event.userKey : null;
  return {
    eventId: event.eventId,
    orgId: event.orgId,
    type: event.type,
    occurredAt: event.occurredAt,
    projectId: event.projectId ?? null,
    itemId: event.itemId ?? null,
    itemType: event.itemType ?? null,
    // A repository is not a person; the policy is about identities.
    remoteUrl: event.remoteUrl ?? null,
    externalId: event.externalId ?? null,
    // Free text written by humans about humans. Dropped wholesale.
    itemTitle: null,
    installationId: anon(event.installationId, 'install') ?? 'anon:unknown',
    userKey: userKey ? pseudonymFor(childHubId, secretKey, userKey) : null,
    actor: null,
    payload,
  };
}

let warnedUnreadable = false;
function warnUnreadableOnce(message: string): void {
  if (warnedUnreadable) return;
  warnedUnreadable = true;
  console.warn(
    '[FEDERATION] this hub has a parent but its stored credential cannot be read, so nothing is being forwarded:',
    message,
  );
}

/** Test seam: the once-per-process warning would otherwise leak between specs. */
export function resetUnreadableWarning(): void { warnedUnreadable = false; }

export interface ForwardResult {
  forwarded: number;
  failed: number;
  policy?: IdentityPolicy;
}

/**
 * Queue already-ingested events for the parent.
 *
 * Call AFTER the local insert: an event this hub did not keep is not one the
 * parent should be told about.
 */
export async function forwardEvents(
  db: DB,
  secretKey: string,
  events: ReadonlyArray<{ userKey?: string | null; [k: string]: unknown }>,
): Promise<ForwardResult> {
  if (events.length === 0) return { forwarded: 0, failed: 0 };

  let binding;
  try {
    binding = await readParentBinding(db, secretKey);
  } catch (err) {
    // Unreadable binding (rotated key): the hub keeps working, it just stops
    // forwarding. Say so once per process — silently ceasing to report is the
    // kind of failure nobody notices for a month.
    warnUnreadableOnce((err as Error).message);
    return { forwarded: 0, failed: 0 };
  }
  if (!binding || binding.state !== 'active') return { forwarded: 0, failed: 0 };

  const policy = binding.identityPolicy;
  const rows: Array<{ kind: string; payload: unknown }> = [];
  let failed = 0;

  for (const event of events) {
    try {
      const shaped = policy === 'pseudonymize'
        ? redactIdentity(event as Record<string, unknown>, binding.childHubId, secretKey)
        : event;
      // The policy travels WITH the row. Reading it off the binding at
      // delivery time would let a switch rewrite the meaning of rows that
      // were queued under the old one.
      rows.push({ kind: 'event', payload: { childHubId: binding.childHubId, identityPolicy: policy, event: shaped } });
    } catch {
      // Per event, so one bad event cannot cost the rest of the batch.
      failed++;
    }
  }

  let forwarded = 0;
  try {
    forwarded = await enqueueOutboxBatch(db, rows);
  } catch {
    // The queue is best-effort by design; the caller has already stored the
    // events locally and must not learn about this.
    return { forwarded: 0, failed: failed + rows.length, policy };
  }
  // Rows the queue itself refused (unserialisable) count as failures too.
  return { forwarded, failed: failed + (rows.length - forwarded), policy };
}
