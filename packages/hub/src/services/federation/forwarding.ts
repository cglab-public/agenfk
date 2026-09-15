import { createHmac } from 'crypto';
import type { DB } from '../../db.js';
import { readParentBinding, type IdentityPolicy } from './parentBinding.js';
import { enqueueOutbox } from './federationSync.js';

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
 * Keyed on the child's own secret AND its hub id, so the parent can count
 * distinct people within a hub without learning who they are, and cannot join
 * the same person across two hubs. Truncated to 64 bits: this is a label in a
 * UI, not a signature.
 */
export function pseudonymFor(childHubId: string, secretKey: string, userKey: string): string {
  const mac = createHmac('sha256', `${secretKey}:${childHubId}`).update(userKey).digest('hex');
  return `anon:${mac.slice(0, 16)}`;
}

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
  } catch {
    // Unreadable binding (rotated key): the hub keeps working, it just does
    // not forward. The status endpoint is where that gets explained.
    return { forwarded: 0, failed: 0 };
  }
  if (!binding || binding.state !== 'active') return { forwarded: 0, failed: 0 };

  const policy = binding.identityPolicy;
  let forwarded = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const userKey = typeof event?.userKey === 'string' ? event.userKey : null;
      const shaped = policy === 'pseudonymize' && userKey
        ? { ...event, userKey: pseudonymFor(binding.childHubId, secretKey, userKey) }
        : event;
      // The policy travels WITH the row. Reading it off the binding at
      // delivery time would let a switch rewrite the meaning of rows that
      // were queued under the old one.
      const queued = await enqueueOutbox(db, 'event', {
        childHubId: binding.childHubId,
        identityPolicy: policy,
        event: shaped,
      });
      if (queued) forwarded++; else failed++;
    } catch {
      // Per event, so one bad event cannot cost the rest of the batch.
      failed++;
    }
  }
  return { forwarded, failed, policy };
}
