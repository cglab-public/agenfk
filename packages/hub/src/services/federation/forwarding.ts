import { createHmac } from 'crypto';
import type { DB } from '../../db.js';
import { readParentBinding } from './parentBinding.js';
import { legacyPolicyFor, type IdentityCoding } from './identityCoding.js';
import { enqueueOutboxBatch } from './federationSync.js';
import { canonicalOccurredAt } from '../../util/occurredAt.js';

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
 * Payload keys the parent's aggregation actually reads. With the person coded
 * the payload is reduced to these rather than filtered for known-bad keys: a
 * deny-list on a free-form blob is a promise nobody can keep, and the fields
 * that matter upstream are a short, known list.
 */
export const FORWARDABLE_PAYLOAD_KEYS = [
  'repo', 'prNumber', 'model', 'harness', 'toStatus', 'leafStory', 'sizingShadow',
  'epic', 'story', 'task', 'bug', 'itemType', 'sizing',
] as const;

const USAGE_NUMBERS = ['turns', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'costUsd', 'estimatedCostUsd', 'unpricedTurns'] as const;
const usageNumbers = (v: any): Record<string, number> =>
  Object.fromEntries(USAGE_NUMBERS.map(k => [k, Number.isFinite(Number(v?.[k])) ? Number(v[k]) : 0]));

const modelsOnly = (v: unknown) => (Array.isArray(v) ? v : []).map((m: any) => ({
  client: String(m?.client ?? 'unknown'),
  model: String(m?.model ?? 'unknown'),
  ...usageNumbers(m),
}));

/**
 * A time in its ISO form only. ISO input is read as ingest reads it; any
 * other spelling Date.parse accepts is re-serialised from the instant, which
 * drops whatever text rode in it ('Thu, 19 Nov 2026 10:00 GMT (a note)').
 * Dropping such a time instead could change which of two sends wins on the
 * parent. A time that does not parse at all is dropped.
 */
function isoOrNothing(v: unknown): string | undefined {
  const iso = canonicalOccurredAt(v);
  if (iso) return iso;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  const year = new Date(t).getUTCFullYear();
  return year >= 1 && year <= 9999 ? new Date(t).toISOString() : undefined;
}

/**
 * A usage blob rebuilt from its known, identity-free fields only (GH-395):
 * token numbers per harness and model, the card's own snapshot and when it
 * was read, the step names and times, the card count and completeness.
 * Anything else a newer sender adds is dropped until it is listed here.
 */
function usageOnly(usage: any): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const out: Record<string, unknown> = { byModel: modelsOnly(usage.byModel), total: usageNumbers(usage.total) };
  for (const k of ['step', 'to'] as const) if (typeof usage[k] === 'string') out[k] = usage[k];
  for (const k of ['enteredAt', 'leftAt'] as const) { const v = isoOrNothing(usage[k]); if (v) out[k] = v; }
  if (typeof usage.complete === 'boolean') out.complete = usage.complete;
  if (Number.isFinite(Number(usage.cards)) && usage.cards !== null) out.cards = Number(usage.cards);
  if (Array.isArray(usage.byStep)) {
    out.byStep = usage.byStep.map((s: any) => ({ step: String(s?.step ?? ''), total: usageNumbers(s?.total) }));
  }
  if (usage.own && typeof usage.own === 'object') {
    const own: Record<string, unknown> = {};
    const asOf = isoOrNothing(usage.own.asOf);
    if (asOf) own.asOf = asOf;
    own.byModel = modelsOnly(usage.own.byModel);
    own.total = usageNumbers(usage.own.total);
    out.own = own;
  }
  return out;
}

/**
 * GH-394: a day's usage on no card, as its day, when it was totalled, and
 * the token numbers per harness and model.
 */
function noCardPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)) out.day = raw.day;
  const asOf = isoOrNothing(raw.asOf);
  if (asOf) out.asOf = asOf;
  const usage = raw.usage as any;
  if (usage && typeof usage === 'object') out.usage = { total: usageNumbers(usage.total), byModel: modelsOnly(usage.byModel) };
  return out;
}

/**
 * The event as the parent may see it, under the coding it asked for.
 *
 * Coding the person means more than rewriting `userKey`: `actor.gitEmail` is
 * the field `userKeyFor` DERIVES the key from, so the parent could recompute
 * the plaintext from the very row that claimed to be coded. Free text
 * (`itemTitle`) and the payload blob routinely carry names, emails and branch
 * names too, so they go with it; the usage numbers are rebuilt so the parent
 * can still count them. The installation id is coded on its own: a stable
 * machine id re-joins one machine across child hubs. Fields not coded travel
 * exactly as written.
 */
export function redactIdentity(
  event: Record<string, unknown>,
  childHubId: string,
  secretKey: string,
  coding: IdentityCoding,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event };
  if (coding.installation === 'coded') {
    const id = event.installationId;
    out.installationId = typeof id === 'string' && id ? pseudonymFor(childHubId, secretKey, `install:${id}`) : 'anon:unknown';
  }
  if (coding.person !== 'coded') return out;

  const rawPayload = event.payload;
  const payload: Record<string, unknown> = {};
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    for (const k of FORWARDABLE_PAYLOAD_KEYS) {
      const v = (rawPayload as Record<string, unknown>)[k];
      if (v !== undefined) payload[k] = v;
    }
    if (event.type === 'usage.no-card') Object.assign(payload, noCardPayload(rawPayload as Record<string, unknown>));
    else {
      const usage = usageOnly((rawPayload as Record<string, unknown>).usage);
      if (usage) payload.usage = usage;
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
    remoteUrl: event.remoteUrl ?? null,
    externalId: event.externalId ?? null,
    externalUrl: event.externalUrl ?? null,
    itemTitle: null,
    installationId: out.installationId ?? null,
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
  coding?: IdentityCoding;
}

/**
 * Queue already-ingested events for the parent (CGLAB-184).
 *
 * Call AFTER the local insert: an event this hub did not keep is not one the
 * parent should be told about. Two rules, in this order:
 *  1. **Forwarding may never become a condition of the child's own ingest.**
 *     Everything here reports failure as a value. A parent that is down, slow,
 *     misconfigured or hostile must not be able to turn a working /v1/events
 *     into a 500 for a developer who has never heard of it.
 *  2. **What is coded belongs to the parent** (identityCoding.ts). The child
 *     applies the coding it was told and stamps it on every row, so a change
 *     can never rewrite the meaning of rows queued under the old one, nor
 *     leave one series with two identity spaces for one person. The binary
 *     `identityPolicy` beside it is what a parent from before per-field coding
 *     reads.
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

  const coding = binding.identity;
  const identityPolicy = legacyPolicyFor(coding);
  const rows: Array<{ kind: string; payload: unknown }> = [];
  let failed = 0;

  for (const event of events) {
    try {
      const shaped = redactIdentity(event as Record<string, unknown>, binding.childHubId, secretKey, coding);
      rows.push({ kind: 'event', payload: { childHubId: binding.childHubId, identity: coding, identityPolicy, event: shaped } });
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
    return { forwarded: 0, failed: failed + rows.length, coding };
  }
  // Rows the queue itself refused (unserialisable) count as failures too.
  return { forwarded, failed: failed + (rows.length - forwarded), coding };
}
