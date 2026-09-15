import { randomUUID } from 'crypto';
import type { DB } from '../../db.js';
import {
  readParentBinding, markBindingRevoked, writeParentBinding, PARENT_BINDING_KEY,
  type ParentBinding, type IdentityPolicy,
} from './parentBinding.js';

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
  delivered?: number;
  error?: string;
  /** The parent said 401 — we have been detached at the other end. */
  revoked?: boolean;
  /** A directive kind this build does not implement yet. */
  unknownDirectiveKind?: string;
  /** Rows the parent refused outright, removed rather than retried forever. */
  dropped?: number;
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
export async function enqueueOutbox(db: DB, kind: string, payload: unknown): Promise<boolean> {
  const bound = await db.get<{ value: string }>(
    'SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY],
  );
  if (!bound?.value) return false;
  // A revoked binding never drains, so continuing to queue would grow the
  // table for the rest of the hub's life with rows nothing will ever send.
  try {
    if (JSON.parse(bound.value)?.state === 'revoked') return false;
  } catch {
    return false;
  }

  // This runs in the request path, so a payload we cannot serialise must cost
  // the event, never the request. JSON.stringify throws on a circular object
  // or a BigInt, and returns undefined for `undefined` — which the NOT NULL
  // column would then reject at the driver.
  let body: string | undefined;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    console.warn('[FEDERATION] dropping an unserialisable outbox payload:', messageOf(err));
    return false;
  }
  if (typeof body !== 'string') {
    console.warn('[FEDERATION] dropping an outbox payload that serialised to undefined');
    return false;
  }

  // An unbounded queue is its own outage: a parent down for a week would grow
  // this table without limit. Past the cap the oldest row makes way, so the
  // most recent history survives.
  const depth = await outboxDepth(db);
  if (depth >= MAX_OUTBOX_ROWS) {
    await db.run(
      `DELETE FROM federation_outbox WHERE seq IN (
         SELECT seq FROM federation_outbox ORDER BY seq ASC LIMIT ${Math.max(1, depth - MAX_OUTBOX_ROWS + 1)})`,
    );
  }

  const now = new Date().toISOString();
  // `seq` rather than created_at for ordering: several rows can share a
  // millisecond and the tie-break was then a random UUID, so a burst came out
  // shuffled. It is a real sequence (AUTOINCREMENT / BIGSERIAL) rather than
  // MAX(seq)+1, which two Postgres connections would read identically.
  await db.run(
    `INSERT INTO federation_outbox (id, kind, payload, created_at, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [randomUUID(), kind, body, now, now],
  );
  return true;
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
      await markBindingRevoked(db, secretKey);
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
      // No kinds are implemented yet — flow dispatch (CGLAB-182) and upgrade
      // dispatch (CGLAB-183) add them. Recording rather than throwing is what
      // lets an older child sit safely under a newer parent.
      result.unknownDirectiveKind = directive.kind;
    }
  } catch (err) {
    if (isRevocation(err)) {
      await markBindingRevoked(db, secretKey);
      return { ok: false, revoked: true, error: messageOf(err) };
    }
    return { ok: false, error: messageOf(err) };
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
      await markBindingRevoked(db, secretKey);
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
export function startFederationSync(args: {
  db: DB;
  secretKey: string;
  hubVersion?: string;
  intervalMs?: number;
  transport?: FederationTransport;
}): () => void {
  const intervalMs = args.intervalMs ?? FEDERATION_TICK_MS;
  let inflight = false;
  let transport: FederationTransport | null = args.transport ?? null;

  const timer = setInterval(() => {
    if (inflight) return;
    inflight = true;
    (async () => {
      try {
        if (!transport) transport = httpTransport();
        const out = await federationTick({
          db: args.db, secretKey: args.secretKey, transport, hubVersion: args.hubVersion,
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
