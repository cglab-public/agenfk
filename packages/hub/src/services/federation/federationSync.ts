import { randomUUID } from 'crypto';
import type { DB } from '../../db.js';
import { readParentBinding, markBindingRevoked, PARENT_BINDING_KEY, type ParentBinding } from './parentBinding.js';

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
 */

/** Base cadence. Also the first backoff step, like the events flusher. */
export const FEDERATION_TICK_MS = 60_000;
export const MAX_FEDERATION_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_FEDERATION_BATCH = 500;
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
  const now = new Date().toISOString();
  // `seq` rather than created_at for ordering: several rows can share a
  // millisecond, and the tie-break was then the random UUID — so a burst came
  // out of the outbox shuffled.
  await db.run(
    `INSERT INTO federation_outbox (id, kind, payload, created_at, attempts, next_attempt_at, seq)
     VALUES (?, ?, ?, ?, 0, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM federation_outbox))`,
    [randomUUID(), kind, JSON.stringify(payload), now, now],
  );
  return true;
}

export async function outboxDepth(db: DB): Promise<number> {
  const row = await db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM federation_outbox');
  return Number(row?.n ?? 0);
}

async function dueRows(db: DB, limit: number): Promise<OutboxRow[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT id, kind, payload, created_at, attempts
       FROM federation_outbox
      WHERE next_attempt_at <= ?
      ORDER BY seq ASC
      LIMIT ${Math.max(1, Math.floor(limit))}`,
    [new Date().toISOString()],
  );
  return rows.map((r: any) => ({
    id: String(r.id),
    kind: String(r.kind),
    payload: safeParse(r.payload),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    attempts: Number(r.attempts ?? 0),
  }));
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

  try {
    await transport.ping({ ...creds, hubVersion });
  } catch (err) {
    if (isRevocation(err)) {
      await markBindingRevoked(db, secretKey);
      return { ok: false, revoked: true, error: messageOf(err) };
    }
    return { ok: false, error: messageOf(err) };
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

  const rows = await dueRows(db, batchSize);
  if (rows.length === 0) return result;

  try {
    await transport.deliver(rows, creds);
  } catch (err) {
    if (isRevocation(err)) {
      await markBindingRevoked(db, secretKey);
      return { ok: false, revoked: true, error: messageOf(err) };
    }
    const status = statusOf(err);
    // An authoritative 4xx means the parent will never accept these bytes.
    // Re-sending them unchanged every five minutes would wedge the queue
    // behind a row that can never leave it, so the batch is dropped and
    // counted rather than retried forever.
    if (status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
      for (const r of rows) {
        await db.run('DELETE FROM federation_outbox WHERE id = ?', [r.id]);
      }
      return { ok: false, delivered: 0, dropped: rows.length, error: messageOf(err) };
    }
    // Everything else comes back later. Each row carries its own attempt count
    // so a slow row backs off on its own rather than resetting the queue.
    for (const r of rows) {
      const attempts = r.attempts + 1;
      await db.run(
        'UPDATE federation_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?',
        [attempts, new Date(Date.now() + backoffMsFor(r.attempts)).toISOString(), r.id],
      );
    }
    return { ok: false, delivered: 0, error: messageOf(err) };
  }

  for (const r of rows) {
    await db.run('DELETE FROM federation_outbox WHERE id = ?', [r.id]);
  }
  result.delivered = rows.length;
  return result;
}

/**
 * The real transport. Every call is bounded by FEDERATION_HTTP_TIMEOUT_MS, so
 * a parent that accepts the connection and then goes quiet costs one tick
 * rather than pinning the worker indefinitely.
 */
export function httpTransport(): FederationTransport {
  // Required lazily so importing this module never pulls axios into a code
  // path (CLI, tests) that has no intention of talking to a parent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const axios = require('axios');
  const call = (token: string) => ({
    headers: { Authorization: `Bearer ${token}` },
    timeout: FEDERATION_HTTP_TIMEOUT_MS,
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
