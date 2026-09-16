import { randomUUID } from 'crypto';
import type { DB } from '../../db.js';
import {
  readParentBinding, markBindingRevoked, writeParentBinding, PARENT_BINDING_KEY,
  type ParentBinding, type IdentityPolicy,
} from './parentBinding.js';
import { releaseParentFlows } from './parentFlows.js';
import { invalidFlowDefinition } from '../flowDefinition.js';
import { applyUpgradeDispatch, type UpgradeDispatch, type UpgradeFanoutResult } from './upgradeFanout.js';
import { applyUpgradeCancel, type UpgradeCancel, type UpgradeCancelResult } from './upgradeCancel.js';
import { reportUpgradeProgress } from './upgradeProgress.js';

/**
 * The child half of hub federation (CGLAB-181).
 *
 * One tick is: heartbeat, poll for a directive, drain the outbox. The rule the
 * whole design serves is that **a child hub keeps working when its parent does
 * not** — so every path here reports failure as a value and none of it throws
 * into the caller. A hub whose parent is down, retired, or was never configured
 * must serve its own users exactly as before.
 *
 * `federationTick` takes its transport as an argument so the decision logic is
 * testable without a network; `startFederationSync` wires the real one to a
 * timer, mirroring rollup.ts.
 *
 * DELIVERY IS AT-LEAST-ONCE, deliberately. Rows are deleted only after the
 * parent accepts them, so a crash or a timeout between the POST and the DELETE
 * re-sends them. The `inflight` guard is per-process, so two hub replicas
 * sharing one Postgres database will both claim the same due rows — there is
 * no row lease. The parent's ingest must therefore be idempotent on the row id
 * (that is a stated requirement of the accumulation story, CGLAB-184). If a
 * lease is ever wanted here, `SELECT ... FOR UPDATE SKIP LOCKED` is the
 * Postgres answer and would need a SQLite equivalent.
 */

/** Base cadence. Also the first backoff step, like the events flusher. */
export const FEDERATION_TICK_MS = 60_000;
export const MAX_FEDERATION_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_FEDERATION_BATCH = 500;
/** Hard ceiling on queued rows; past it the oldest make way for the newest. */
export const MAX_OUTBOX_ROWS = 50_000;
/**
 * How many times a row must be rejected ON ITS OWN before it is discarded.
 * Bisection isolates the row the parent objects to; this stops a parent that
 * answers 400 to everything from emptying the queue in a single tick.
 */
export const MAX_ROW_REJECTIONS = 3;
/** Every outbound call is bounded; a hung parent must not pin a tick forever. */
export const FEDERATION_HTTP_TIMEOUT_MS = 15_000;

/**
 * 4xx codes that mean "come back later" rather than "you are not welcome".
 * Same set as the events flusher: without this, a parent behind a rate limiter
 * would look like a revocation and the child would stop talking to it for good.
 */
const RETRYABLE_4XX = new Set([408, 425, 429]);

export interface OutboxRow {
  id: string;
  kind: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  rejections: number;
}

export interface FederationTransport {
  ping(args: { parentUrl: string; token: string; hubVersion?: string }): Promise<unknown>;
  directives(args: { parentUrl: string; token: string }): Promise<{ kind?: string } | null>;
  deliver(rows: OutboxRow[], args: { parentUrl: string; token: string }): Promise<unknown>;
}

export interface TickResult {
  ok: boolean;
  /** Set when the tick did no work: there is nothing to do, not a failure. */
  skipped?: 'no-binding' | 'revoked';
  /** What a pulled upgrade.dispatch did to this hub's own fleet (CGLAB-183). */
  upgradeFanout?: UpgradeFanoutResult;
  upgradeDispatchError?: string;
  /** What a pulled upgrade.cancel stopped (CGLAB-183). */
  upgradeCancel?: UpgradeCancelResult;
  delivered?: number;
  error?: string;
  /** The parent said 401 — we have been detached at the other end. */
  revoked?: boolean;
  /** A directive kind this build does not implement yet. */
  unknownDirectiveKind?: string;
  /** Rows the parent refused outright, removed rather than retried forever. */
  dropped?: number;
  /** A flow.dispatch we could not install. Reported, never thrown: the outbox
   *  drain still has to run, and one bad directive must not stop delivery. */
  flowDispatchError?: string;
}

/** Exponential from the tick interval, capped. Mirrors the events flusher. */
export function backoffMsFor(attempts: number): number {
  return Math.min(MAX_FEDERATION_BACKOFF_MS, FEDERATION_TICK_MS * Math.pow(2, Math.max(0, attempts)));
}

function statusOf(err: unknown): number | null {
  const s = (err as any)?.response?.status;
  return typeof s === 'number' ? s : null;
}

/** Does this failure mean the parent has detached us, rather than "try later"? */
function isRevocation(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

function messageOf(err: unknown): string {
  return (err as any)?.message ? String((err as any).message) : String(err);
}

/**
 * Queue a row for the parent. A no-op when this hub has no parent — otherwise a
 * standalone hub would accumulate rows forever for a parent that never comes.
 */
/** Is this hub currently forwarding to a parent? Cheap, and the same gate for one row or many. */
async function outboxAccepting(db: DB): Promise<boolean> {
  const bound = await db.get<{ value: string }>(
    'SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY],
  );
  if (!bound?.value) return false;
  // A revoked binding never drains, so continuing to queue would grow the
  // table for the rest of the hub's life with rows nothing will ever send.
  try {
    return JSON.parse(bound.value)?.state !== 'revoked';
  } catch {
    return false;
  }
}

/** Serialise a payload, or null when it cannot be stored. Never throws. */
function serialisePayload(payload: unknown): string | null {
  // This runs in the request path, so a payload we cannot serialise must cost
  // the event, never the request. JSON.stringify throws on a circular object
  // or a BigInt, and returns undefined for `undefined` — which the NOT NULL
  // column would then reject at the driver.
  let body: string | undefined;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    console.warn('[FEDERATION] dropping an unserialisable outbox payload:', messageOf(err));
    return null;
  }
  if (typeof body !== 'string') {
    console.warn('[FEDERATION] dropping an outbox payload that serialised to undefined');
    return null;
  }
  return body;
}

/** Trim the oldest rows once the queue is over its ceiling. */
async function trimOutbox(db: DB, incoming: number): Promise<void> {
  // An unbounded queue is its own outage: a parent down for a week would grow
  // this table without limit. Past the cap the oldest rows make way, so the
  // most recent history survives.
  const depth = await outboxDepth(db);
  const over = depth + incoming - MAX_OUTBOX_ROWS;
  if (over <= 0) return;
  await db.run(
    `DELETE FROM federation_outbox WHERE seq IN (
       SELECT seq FROM federation_outbox ORDER BY seq ASC LIMIT ${safeLimit(over)})`,
  );
}

/**
 * Queue rows for the parent. A no-op when this hub has no parent — otherwise a
 * standalone hub would accumulate rows forever for a parent that never comes.
 *
 * Batched deliberately. Queuing one row at a time cost three statements and a
 * commit PER EVENT, so a 500-event batch added 1500 statements to a request,
 * and the per-row depth check turned a full outbox into a scan per event. That
 * made the child's own ingest slower the sicker its parent was — the exact
 * coupling this whole design exists to avoid.
 */
export async function enqueueOutboxBatch(
  db: DB,
  rows: ReadonlyArray<{ kind: string; payload: unknown }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!(await outboxAccepting(db))) return 0;

  const now = new Date().toISOString();
  const values: Array<[string, string, string, string, string]> = [];
  for (const r of rows) {
    const body = serialisePayload(r.payload);
    if (body === null) continue;
    values.push([randomUUID(), r.kind, body, now, now]);
  }
  if (values.length === 0) return 0;

  await db.transaction(async () => {
    await trimOutbox(db, values.length);
    for (const v of values) {
      await db.run(
        `INSERT INTO federation_outbox (id, kind, payload, created_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        v,
      );
    }
  });
  return values.length;
}

/** Single-row convenience over {@link enqueueOutboxBatch}. */
export async function enqueueOutbox(db: DB, kind: string, payload: unknown): Promise<boolean> {
  return (await enqueueOutboxBatch(db, [{ kind, payload }])) === 1;
}

export async function outboxDepth(db: DB): Promise<number> {
  const row = await db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM federation_outbox');
  return Number(row?.n ?? 0);
}

async function dueRows(db: DB, limit: number): Promise<OutboxRow[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT id, kind, payload, created_at, attempts, rejections
       FROM federation_outbox
      WHERE next_attempt_at <= ?
      ORDER BY seq ASC
      LIMIT ${safeLimit(limit)}`,
    [new Date().toISOString()],
  );
  return rows.map((r: any) => ({
    id: String(r.id),
    kind: String(r.kind),
    payload: safeParse(r.payload),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    attempts: Number(r.attempts ?? 0),
    rejections: Number(r.rejections ?? 0),
  }));
}

/** A LIMIT is interpolated, so a non-finite batch size must never reach the SQL. */
function safeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_FEDERATION_BATCH;
}

function safeParse(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export interface TickArgs {
  db: DB;
  secretKey: string;
  transport: FederationTransport;
  hubVersion?: string;
  batchSize?: number;
  /** Which org a dispatched flow is installed into — this hub's own. */
  orgId?: string;
}

/** The org a dispatched flow lands in when the caller does not say. */
const DEFAULT_ORG = 'default';

interface FlowDispatch {
  kind: 'flow.dispatch';
  dispatchId?: string;
  flowVersion?: number;
  flow?: {
    id?: string;
    name?: string;
    description?: string | null;
    version?: number;
    definition?: unknown;
  };
}

/**
 * Install (or update) a flow the parent hub sent.
 *
 * Keyed on the PARENT's flow id, so a re-dispatch updates the same row instead
 * of piling up copies — and so a flow the child authored with the same NAME is
 * untouched, which is what the user chose: flows are keyed by id, and nothing
 * local is ever overwritten by the group.
 *
 * Idempotent and monotonic in one statement: `WHERE excluded.version >
 * flows.version` means a redelivered dispatch is a no-op (delivery is
 * at-least-once, so it happens routinely) and a late redelivery of an OLDER
 * version cannot walk the flow backwards.
 *
 * `OR flows.source <> 'parent'` is what makes a RE-JOIN work. A hub that left
 * the group kept these rows at the parent's id and the parent's version, but
 * released to source='hub' (see releaseParentFlows). If the parent has not
 * bumped the flow since, re-dispatching it carries the SAME version, so the
 * monotonic guard alone would decline to re-lock it — leaving the child freely
 * editing a flow the parent owns again while the parent's board reports it
 * landed. The version guard still holds for a flow that is already ours: this
 * clause only fires when the row is NOT currently parent-owned.
 *
 * `org_available = 1` because a dispatched flow exists to be picked up
 * org-wide; that is the whole point of sending it.
 */
export async function installDispatchedFlow(db: DB, orgId: string, directive: FlowDispatch): Promise<boolean> {
  const flow = directive.flow;
  if (!flow || typeof flow.id !== 'string' || !flow.id) return false;
  if (typeof flow.name !== 'string' || !flow.name) return false;
  // The same structural check this hub applies to its own admins' input. The
  // parent is a different hub, so this is a trust boundary — and `typeof []`
  // is 'object', which is how an empty definition used to install cleanly and
  // reach every installation in the org.
  if (invalidFlowDefinition(flow.definition)) return false;

  const version = Number(directive.flowVersion ?? flow.version ?? 1);
  if (!Number.isFinite(version)) return false;

  await db.run(
    `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, org_available, updated_at)
     VALUES (?, ?, ?, ?, ?, 'parent', ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- Content moves only on a genuinely newer version. A reclaim (see the
       -- WHERE below) returns OWNERSHIP without rolling the content back: a
       -- flow released on detach is edited locally and its version climbs, so
       -- the parent's copy is usually OLDER by the time the hub rejoins, and
       -- overwriting it would silently destroy that work.
       name = CASE WHEN excluded.version > flows.version THEN excluded.name ELSE flows.name END,
       description = CASE WHEN excluded.version > flows.version THEN excluded.description ELSE flows.description END,
       definition_json = CASE WHEN excluded.version > flows.version THEN excluded.definition_json ELSE flows.definition_json END,
       version = CASE WHEN excluded.version > flows.version THEN excluded.version ELSE flows.version END,
       source = 'parent',
       -- NOT forced back on. Which flows this hub offers its own teams is the
       -- child's choice — the availability toggle is deliberately left
       -- unlocked on a parent-origin flow — so a version bump must not
       -- re-publish something an admin took out of the picker. A flow arriving
       -- for the FIRST time is still published, by the INSERT above.
       org_available = flows.org_available,
       updated_at = excluded.updated_at
     WHERE excluded.version > flows.version OR flows.source <> 'parent'`,
    [flow.id, orgId, flow.name, flow.description ?? null,
     JSON.stringify(flow.definition), version, new Date().toISOString()],
  );
  return true;
}

/**
 * The child's answer to a flow dispatch.
 *
 * The event id is DERIVED from the dispatch id and the outcome, never random.
 * The outbox has no lease, so delivery is at-least-once and the same report
 * reaches the parent more than once as a matter of course; the parent dedups
 * on the event id, so a stable id is what turns a retry into one report rather
 * than a new one each time. It also means a re-run of the same directive
 * cannot double-count.
 */
export async function reportFlowDispatch(
  db: DB,
  directive: FlowDispatch,
  detail: string | null,
): Promise<void> {
  const dispatchId = typeof directive?.dispatchId === 'string' ? directive.dispatchId : null;
  // Nothing to answer for: a directive with no id cannot name a target row,
  // and inventing one would move the wrong hub's state.
  if (!dispatchId) return;
  const state = detail === null ? 'installed' : 'failed';
  await enqueueOutbox(db, 'event', {
    event: {
      eventId: `flow-dispatch:${dispatchId}:${state}`,
      type: `fleet:flow-dispatch:${state}`,
      occurredAt: new Date().toISOString(),
      userKey: 'system',
      payload: { dispatchId, detail },
    },
  });
}

/**
 * Record that the parent has let this hub go, and hand its flows back in the
 * same breath.
 *
 * These two belong together and the pairing is easy to forget: a tick can
 * discover the revocation on any of its three legs, and once the binding reads
 * 'revoked' every LATER tick returns early before it reaches the first leg
 * again. So a leg that revokes without releasing does not get a second chance
 * — the flows stay locked to a parent that is gone until an admin happens to
 * click Leave, which is the exact stranding the release exists to prevent.
 */
async function revokeAndRelease(db: DB, secretKey: string): Promise<void> {
  await markBindingRevoked(db, secretKey);
  await releaseParentFlows(db);
}

export async function federationTick(args: TickArgs): Promise<TickResult> {
  const { db, secretKey, transport, hubVersion } = args;
  const batchSize = args.batchSize ?? DEFAULT_FEDERATION_BATCH;

  let binding: ParentBinding | null;
  try {
    binding = await readParentBinding(db, secretKey);
  } catch (err) {
    // A binding we cannot decrypt (rotated secret, tampered row) is reported,
    // not thrown — the hub keeps serving.
    return { ok: false, error: messageOf(err) };
  }
  if (!binding) return { ok: true, skipped: 'no-binding' };
  if (binding.state === 'revoked') return { ok: true, skipped: 'revoked' };

  const creds = { parentUrl: binding.parentUrl, token: binding.token };

  let pong: any;
  try {
    pong = await transport.ping({ ...creds, hubVersion });
  } catch (err) {
    if (isRevocation(err)) {
      await revokeAndRelease(db, secretKey);
      return { ok: false, revoked: true, error: messageOf(err) };
    }
    return { ok: false, error: messageOf(err) };
  }

  // The parent owns the identity policy; persist whatever it just told us so
  // the next batch of forwarded events is stamped correctly. A parent that
  // says nothing leaves the cached value alone.
  const told = pong?.identityPolicy;
  const recognised = told === 'keep' || told === 'pseudonymize';
  if (recognised && told !== binding.identityPolicy) {
    await writeParentBinding(db, secretKey, { ...binding, identityPolicy: told as IdentityPolicy });
  }

  const result: TickResult = { ok: true, delivered: 0 };

  try {
    const directive = await transport.directives(creds);
    if (directive && typeof directive.kind === 'string') {
      if (directive.kind === 'flow.dispatch') {
        // A malformed or unusable directive must not take the tick down with
        // it — the outbox drain below still has to run, and a child that
        // crashes on one bad directive stops delivering anything at all.
        const d = directive as FlowDispatch;
        let detail: string | null = null;
        try {
          const applied = await installDispatchedFlow(db, args.orgId ?? DEFAULT_ORG, d);
          if (!applied) detail = 'the directive did not carry a usable flow definition';
        } catch (err) {
          detail = messageOf(err);
          result.flowDispatchError = detail;
        }
        // Tell the parent what actually happened. Serving a directive is not
        // the flow landing, so until this arrives the parent's target row
        // stays `pending` — which is the honest answer, and the whole reason
        // the target table exists.
        //
        // Queued through the ordinary outbox rather than sent inline: the
        // report must not be able to fail the tick, and a child whose parent
        // is briefly down still owes it this answer when it comes back.
        // Its own try: this sits inside the block whose catch RETURNS, so an
        // enqueue failure here used to skip dueRows and deliverBatch entirely
        // — the precise opposite of what the paragraph above promises.
        try {
          await reportFlowDispatch(db, d, detail);
        } catch (err) {
          result.flowDispatchError = result.flowDispatchError ?? messageOf(err);
        }
      } else if (directive.kind === 'upgrade.dispatch') {
        // The parent named a version; which of THIS hub's machines that means
        // is ours to work out. Same shape as the flow arm: a bad directive
        // must not take the tick down, because the outbox drain below still
        // has to run. Reporting the outcome upstream is task 3.
        try {
          const fanout = await applyUpgradeDispatch(
            db, args.orgId ?? DEFAULT_ORG, directive as UpgradeDispatch,
          );
          result.upgradeFanout = fanout;
          // A refusal is returned as a value, not thrown — but the parent
          // re-serves until the child reports, so a directive this hub will
          // never accept comes back every tick. Surfacing it here is what
          // stops that being a silent, permanent loop.
          if (fanout.outcome === 'invalid') result.upgradeDispatchError = fanout.error;
        } catch (err) {
          result.upgradeDispatchError = messageOf(err);
        }
      } else if (directive.kind === 'upgrade.cancel') {
        try {
          result.upgradeCancel = await applyUpgradeCancel(
            db, args.orgId ?? DEFAULT_ORG, directive as UpgradeCancel,
          );
          if (result.upgradeCancel.error) result.upgradeDispatchError = result.upgradeCancel.error;
        } catch (err) {
          result.upgradeDispatchError = messageOf(err);
        }
      } else {
        // A kind this build does not implement. Recording rather than throwing
        // is what lets an older child sit safely under a newer parent.
        result.unknownDirectiveKind = directive.kind;
      }
    }
  } catch (err) {
    if (isRevocation(err)) {
      await revokeAndRelease(db, secretKey);
      return { ok: false, revoked: true, error: messageOf(err) };
    }
    return { ok: false, error: messageOf(err) };
  }

  // Tell the parent how the group upgrade is going, before the drain below so
  // a report queued now goes out in this same pass. On change only: a settled
  // rollout queues nothing, which is the common case.
  try {
    await reportUpgradeProgress(db, args.orgId ?? DEFAULT_ORG);
  } catch (err) {
    // A courtesy to the parent, exactly like the flow-dispatch report: it must
    // never be able to cost this hub its delivery pass.
    result.upgradeDispatchError = result.upgradeDispatchError ?? messageOf(err);
  }

  let rows: OutboxRow[];
  try {
    rows = await dueRows(db, batchSize);
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  if (rows.length === 0) return result;

  try {
    const outcome = await deliverBatch(db, transport, creds, rows);
    if (outcome.revoked) {
      await revokeAndRelease(db, secretKey);
      return { ok: false, revoked: true, error: outcome.error };
    }
    result.delivered = outcome.delivered;
    if (outcome.dropped) result.dropped = outcome.dropped;
    if (outcome.error) { result.ok = false; result.error = outcome.error; }
    return result;
  } catch (err) {
    // dueRows and the bookkeeping writes are the only places left that can
    // throw; a caller (a future "sync now" endpoint) must get a value back.
    return { ok: false, error: messageOf(err) };
  }
}

interface BatchOutcome {
  delivered: number;
  dropped: number;
  revoked?: boolean;
  error?: string;
}

/**
 * Deliver a batch, isolating whatever the parent objects to.
 *
 * An authoritative 4xx used to discard the whole batch, so one malformed row
 * took up to 500 good ones with it — and a hostile or broken parent could
 * empty a child's queue by answering 400 to everything. Now the batch is
 * bisected until the offending row is alone, and even then it is only
 * discarded after MAX_ROW_REJECTIONS individual refusals, which bounds what a
 * misbehaving parent can destroy and leaves an operator a window to notice.
 */
async function deliverBatch(
  db: DB,
  transport: FederationTransport,
  creds: { parentUrl: string; token: string },
  rows: OutboxRow[],
): Promise<BatchOutcome> {
  try {
    await transport.deliver(rows, creds);
  } catch (err) {
    // Being detached is never a payload problem: it must revoke, not drop.
    // Falling through to the drop path here deleted the outbox against a
    // parent that had already cut us off.
    if (isRevocation(err)) return { delivered: 0, dropped: 0, revoked: true, error: messageOf(err) };

    const status = statusOf(err);
    const authoritative = status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);

    if (!authoritative) {
      await backoffRows(db, rows);
      return { delivered: 0, dropped: 0, error: messageOf(err) };
    }

    if (rows.length > 1) {
      const mid = Math.ceil(rows.length / 2);
      const left = await deliverBatch(db, transport, creds, rows.slice(0, mid));
      if (left.revoked) return left;
      const right = await deliverBatch(db, transport, creds, rows.slice(mid));
      if (right.revoked) return right;
      return {
        delivered: left.delivered + right.delivered,
        dropped: left.dropped + right.dropped,
        error: left.error ?? right.error ?? messageOf(err),
      };
    }

    const row = rows[0];
    const rejections = row.rejections + 1;
    if (rejections >= MAX_ROW_REJECTIONS) {
      await db.run('DELETE FROM federation_outbox WHERE id = ?', [row.id]);
      console.warn(`[FEDERATION] discarding outbox row ${row.id} after ${rejections} refusals by the parent`);
      return { delivered: 0, dropped: 1, error: messageOf(err) };
    }
    await db.run(
      'UPDATE federation_outbox SET rejections = ?, attempts = ?, next_attempt_at = ? WHERE id = ?',
      [rejections, row.attempts + 1, new Date(Date.now() + backoffMsFor(row.attempts)).toISOString(), row.id],
    );
    return { delivered: 0, dropped: 0, error: messageOf(err) };
  }

  for (const r of rows) {
    await db.run('DELETE FROM federation_outbox WHERE id = ?', [r.id]);
  }
  return { delivered: rows.length, dropped: 0 };
}

/** Push a batch out to its next attempt, each row on its own schedule. */
async function backoffRows(db: DB, rows: OutboxRow[]): Promise<void> {
  for (const r of rows) {
    await db.run(
      'UPDATE federation_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?',
      // r.attempts is the count BEFORE this failure, so the first retry waits
      // one tick interval rather than two.
      [r.attempts + 1, new Date(Date.now() + backoffMsFor(r.attempts)).toISOString(), r.id],
    );
  }
}

export function httpTransport(axiosLike?: any): FederationTransport {
  // Required lazily so importing this module never pulls axios into a code
  // path (CLI, tests) that has no intention of talking to a parent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const axios = axiosLike ?? require('axios');
  const call = (token: string) => ({
    headers: { Authorization: `Bearer ${token}` },
    timeout: FEDERATION_HTTP_TIMEOUT_MS,
    // A federation parent has no business redirecting. Following one would let
    // it bounce the bearer token to a sibling host (follow-redirects keeps the
    // Authorization header across subdomains), and a 307 on /deliver would
    // re-POST this org's telemetry to wherever it pointed.
    maxRedirects: 0,
  });
  return {
    async ping({ parentUrl, token, hubVersion }) {
      const r = await axios.post(`${parentUrl}/v1/federation/ping`, { hubVersion }, call(token));
      return r.data;
    },
    async directives({ parentUrl, token }) {
      const r = await axios.get(`${parentUrl}/v1/federation/directives`, {
        ...call(token),
        // 204 means "nothing to do" and must not be an error.
        validateStatus: (s: number) => s === 200 || s === 204,
      });
      return r.status === 204 ? null : r.data;
    },
    async deliver(rows, { parentUrl, token }) {
      const r = await axios.post(`${parentUrl}/v1/federation/deliver`, { rows }, call(token));
      return r.data;
    },
  };
}

/**
 * Start the child-side worker. Returns a stop function.
 *
 * Deliberately never rejects and never lets a tick's failure escape: this runs
 * beside the hub's own request handling, and a parent's problems must not
 * become the child's. Ticks cannot overlap — a slow parent would otherwise
 * stack them until something gives.
 */
/** Module-scope so the warning is once per process, not once per tick. */
let warnedTestRunner = false;

export function startFederationSync(args: {
  db: DB;
  secretKey: string;
  hubVersion?: string;
  intervalMs?: number;
  transport?: FederationTransport;
  orgId?: string;
}): () => void {
  const intervalMs = args.intervalMs ?? FEDERATION_TICK_MS;
  let inflight = false;
  let transport: FederationTransport | null = args.transport ?? null;

  const timer = setInterval(() => {
    if (inflight) return;
    inflight = true;
    (async () => {
      try {
        // Build the real transport only outside a test runner. createHubApp
        // starts this worker unconditionally and 70 of 71 hub test files inject
        // no transport, so without this guard every test holding a parent
        // binding had a timer dialling whatever host that binding named — and
        // those are real resolvable domains (parent.example.com). An INJECTED
        // transport is a fake and still runs, which is what the federation
        // suites rely on.
        if (!transport) {
          if ((process.env.NODE_ENV === 'test' || !!process.env.VITEST)
            && process.env.AGENFK_TEST_ENABLE_FEDERATION !== '1') {
            // Say so once. A hub really running with NODE_ENV=test would
            // otherwise stop federating with no log line at all, which is a
            // worse failure than the one this guard prevents.
            if (!warnedTestRunner) {
              warnedTestRunner = true;
              console.warn(
                '[FEDERATION] sync disabled: a test runner was detected (NODE_ENV=test or VITEST) '
                + 'and no transport was injected. Set AGENFK_TEST_ENABLE_FEDERATION=1 to override.',
              );
            }
            return;
          }
          transport = httpTransport();
        }
        const out = await federationTick({
          db: args.db, secretKey: args.secretKey, transport, hubVersion: args.hubVersion,
          orgId: args.orgId,
        });
        if (out.revoked) {
          console.warn('[FEDERATION] parent rejected our credential; sync stopped until this hub rejoins');
        } else if (!out.ok && out.error) {
          console.warn('[FEDERATION] tick failed:', out.error);
        }
      } catch (err) {
        // Belt and braces: federationTick is written not to throw, but a bug
        // in it must still not take the hub's process down.
        console.warn('[FEDERATION] tick threw:', (err as Error).message);
      } finally {
        inflight = false;
      }
    })();
  }, intervalMs);
  // Never hold the process open for a background sync.
  timer.unref?.();
  return () => clearInterval(timer);
}
