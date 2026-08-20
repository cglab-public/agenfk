/**
 * Flusher failure classification, delivery validation and self-healing
 * (BUG 1843e145 / CGLAB-63).
 *
 * The flusher used to treat EVERY 4xx as an authoritative rejection: five such
 * cycles set `halted = true` and nothing outside the constructor ever cleared
 * it, so the install stopped delivering for the remaining lifetime of the API
 * server process. Off-VPN that fires routinely, because captive portals and
 * corporate proxies answer 403/407 — or 404 with an HTML body — instead of
 * failing the TCP connection.
 *
 * Two discriminators do the work now:
 *   - a REJECTION is authoritative only if the body carries the hub's own JSON
 *     error shape and the status is not retryable (packages/hub/src/auth/apiKey.ts
 *     answers 401 {error}, routes/events.ts 400/413, rateLimit.ts 429);
 *   - a DELIVERY only counts if the response carries the hub's ingest ack. A
 *     captive portal answering 200 + HTML must never be mistaken for success,
 *     because a successful flush deletes the batch.
 *
 * Behaviour-based: a real Flusher over a real SQLite outbox with an injected
 * mock transport; assertions are on observable state (halted flag, outbox
 * contents, whether the transport was invoked again).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { Flusher } from '../hub/flusher';

const HUB_CONFIG = { url: 'http://hub.test', token: 't', orgId: 'acme' };
/** Mirrors MAX_BACKOFF_MS in the flusher; the probe cadence ceiling. */
const MAX_BACKOFF_MS = 5 * 60_000;

/** An axios-shaped rejection, as the real transport produces. */
function httpError(status: number | undefined, data: any) {
  const e: any = new Error(status ? `Request failed with status code ${status}` : 'socket hang up');
  if (status !== undefined) e.response = { status, data };
  e.isAxiosError = true;
  return e;
}

/** The real POST /v1/events acknowledgement shape. */
const ack = (n: number) => ({ status: 200, data: { ingested: n, skipped: 0, rejected: 0 } });

/**
 * Mock transport. `postImpl` drives POST /v1/events; `pingOk` / `pingData`
 * drive the GET /v1/ping recovery probe. Both record their invocations.
 */
function makeHttp(opts: { postImpl?: (body: any) => Promise<any>; pingOk?: boolean; pingData?: unknown } = {}) {
  const posted: any[] = [];
  const gets: string[] = [];
  const http: any = {
    post: async (url: string, body: any) => {
      posted.push({ url, body });
      if (opts.postImpl) return opts.postImpl(body);
      return ack(body?.events?.length ?? 0);
    },
    get: async (url: string) => {
      gets.push(url);
      if (opts.pingOk === false) throw httpError(503, '');
      if (opts.pingData !== undefined) return { status: 200, data: opts.pingData };
      return { status: 200, data: { ok: true, orgId: HUB_CONFIG.orgId } };
    },
  };
  return { http, posted, gets };
}

describe('Flusher failure classification and recovery', () => {
  let dbPath: string;
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flusher-4xx-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const suffix of ['', '-shm', '-wal']) {
      const f = `${dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function queue(n: number, orgId = 'acme') {
    for (let i = 0; i < n; i++) {
      storage.hubOutboxAppend(
        `ev-${i}-${Math.random().toString(36).slice(2)}`,
        new Date().toISOString(),
        JSON.stringify({ orgId, type: 'item.created', payload: { seq: i } }),
      );
    }
  }

  /**
   * Drive exactly `n` delivery attempts. Every failure now arms a backoff, so
   * one flushNow() call performs one cycle and then returns at the gate.
   */
  async function attempts(flusher: Flusher, n: number) {
    for (let i = 0; i < n; i++) await flusher.flushNow(200);
  }

  /** Skip past a backoff/probe window without waiting for it. */
  function advance(ms: number) {
    vi.setSystemTime(new Date(Date.now() + ms));
  }

  describe('a 2xx that is not the hub must not be treated as delivery', () => {
    it('keeps the batch when a captive portal answers 200 with an HTML login page', async () => {
      queue(3);
      const { http } = makeHttp({ postImpl: async () => ({ status: 200, data: '<html>login</html>' }) });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await flusher.flushNow(200);

      // The whole point: a successful flush DELETES rows, so trusting a bare
      // 2xx would destroy events that never reached the hub.
      expect(storage.hubOutboxCount()).toBe(3);
      expect(flusher.getStatus().lastError).toBeTruthy();
    });

    it('keeps the batch when a proxy answers 200 with an empty JSON object', async () => {
      queue(2);
      const { http } = makeHttp({ postImpl: async () => ({ status: 200, data: {} }) });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await flusher.flushNow(200);

      expect(storage.hubOutboxCount()).toBe(2);
    });

    it('deletes the batch only on a real hub ingest acknowledgement', async () => {
      queue(2);
      const { http } = makeHttp();
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await flusher.flushNow(500);

      expect(storage.hubOutboxCount()).toBe(0);
      expect(flusher.getStatus().consecutiveFailures).toBe(0);
    });
  });

  describe('transport-level 4xx interposed by a proxy', () => {
    it('never halts on 403 with an HTML body, however many cycles run', async () => {
      queue(2);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(403, '<html><body>Access Denied</body></html>'); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8); // well past HALT_AFTER_4XX_ATTEMPTS (5)

      expect(flusher.getStatus().halted).toBe(false);
      expect(storage.hubOutboxCount()).toBe(2); // nothing dropped
    });

    it('never halts on 407 proxy-authentication-required with an empty body', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(407, ''); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8);

      expect(flusher.getStatus().halted).toBe(false);
      expect(storage.hubOutboxCount()).toBe(1);
    });

    it('never halts on 404 with a non-JSON body (retired hostname behind a proxy)', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(404, 'not found'); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8);

      expect(flusher.getStatus().halted).toBe(false);
    });

    it('never halts when there is no response at all (connection failure)', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(undefined, undefined); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8);

      expect(flusher.getStatus().halted).toBe(false);
    });

    it('applies backoff so it does not hot-loop against the proxy', async () => {
      queue(1);
      const { http, posted } = makeHttp({ postImpl: async () => { throw httpError(403, '<html/>'); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await flusher.flushNow(200);
      const afterFirst = posted.length;
      await flusher.flush(); // gated by backoff — must not reach the transport

      expect(posted.length).toBe(afterFirst);
      expect(flusher.getStatus().nextRetryAt).toBeTruthy();
    });

    it('resumes delivery once the proxy is out of the way', async () => {
      queue(2);
      let blocked = true;
      const { http } = makeHttp({
        postImpl: async (body: any) => {
          if (blocked) throw httpError(403, '<html/>');
          return ack(body?.events?.length ?? 0);
        },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8);
      blocked = false;
      await flusher.flushNow(500);

      expect(storage.hubOutboxCount()).toBe(0);
      expect(flusher.getStatus().halted).toBe(false);
    });
  });

  describe('retryable 4xx', () => {
    it('never halts on 429, even though the hub JSON error shape is present', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(429, { error: 'Too many requests, slow down.' }); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8);

      // Rate limiting means "later", not "never" — halting would strand the outbox.
      expect(flusher.getStatus().halted).toBe(false);
      expect(storage.hubOutboxCount()).toBe(1);
    });

    it('never halts on 408 request timeout', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(408, { error: 'Request Timeout' }); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 8);

      expect(flusher.getStatus().halted).toBe(false);
    });
  });

  describe('authoritative 4xx from the hub itself', () => {
    const revoked = () => httpError(401, { error: 'Invalid or revoked token' });

    it('halts on a revoked-token 401 carrying the hub JSON error shape', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw revoked(); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 6);

      expect(flusher.getStatus().halted).toBe(true);
      expect(storage.hubOutboxCount()).toBe(1); // halted, not discarded
    });

    it('halts on a 400 rejection carrying the hub JSON error shape', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(400, { error: 'Body must contain a non-empty events array' }); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 6);

      expect(flusher.getStatus().halted).toBe(true);
    });

    it('surfaces the hub error message in status for `agenfk hub status`', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw revoked(); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 6);

      expect(flusher.getStatus().lastError).toContain('Invalid or revoked token');
    });

    it('halts exactly at the attempt threshold, not before', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw revoked(); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 4);
      expect(flusher.getStatus().halted).toBe(false);

      await attempts(flusher, 1); // 5th attempt
      expect(flusher.getStatus().halted).toBe(true);
    });

    it('backs off between attempts instead of hammering the hub up to the halt', async () => {
      queue(1);
      const { http, posted } = makeHttp({ postImpl: async () => { throw revoked(); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await flusher.flushNow(200);
      await flusher.flush();
      await flusher.flush();

      expect(posted.length).toBe(1); // the two gated calls never reached the transport
    });

    it('treats a body whose error field is empty or non-string as not authoritative', async () => {
      for (const data of [{ error: '' }, { error: 123 }, [], { message: 'nope' }]) {
        const localPath = path.join(os.tmpdir(), `flusher-shape-${Math.random().toString(36).slice(2)}.sqlite`);
        const localStore = new SQLiteStorageProvider();
        await localStore.init({ path: localPath });
        localStore.hubOutboxAppend('e1', new Date().toISOString(), JSON.stringify({ orgId: 'acme', type: 'item.created' }));
        const { http } = makeHttp({ postImpl: async () => { throw httpError(400, data); } });
        const flusher = new Flusher(localStore, HUB_CONFIG, 'inst', 30_000, 500, http);

        await attempts(flusher, 8);

        expect(flusher.getStatus().halted, `body ${JSON.stringify(data)} must not halt`).toBe(false);
        for (const suffix of ['', '-shm', '-wal']) {
          const f = `${localPath}${suffix}`;
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      }
    });
  });

  describe('self-healing out of the halted state', () => {
    /** A halted flusher plus a lever to stop the hub rejecting. */
    async function haltedFlusher(opts: { pingOk?: boolean; pingData?: unknown } = {}) {
      queue(2);
      let rejecting = true;
      const { http, gets, posted } = makeHttp({
        ...opts,
        postImpl: async (body: any) => {
          if (rejecting) throw httpError(401, { error: 'Invalid or revoked token' });
          return ack(body?.events?.length ?? 0);
        },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);
      await attempts(flusher, 6);
      expect(flusher.getStatus().halted).toBe(true);
      return { flusher, gets, posted, unblock: () => { rejecting = false; } };
    }

    it('probes /v1/ping while halted instead of going permanently silent', async () => {
      const { flusher, gets } = await haltedFlusher();
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1); // past the probe window armed by the halt

      await flusher.flush();

      expect(gets.some(u => u.includes('/v1/ping'))).toBe(true);
    });

    it('does not re-POST events while halted', async () => {
      const { flusher, posted } = await haltedFlusher({ pingOk: false });
      const before = posted.length;
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1);

      await flusher.flush();

      expect(posted.length).toBe(before);
    });

    it('probes at most once per backoff window', async () => {
      const { flusher, gets } = await haltedFlusher({ pingOk: false });
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1);

      await flusher.flush();
      await flusher.flush();
      await flusher.flush();

      expect(gets.length).toBe(1);
    });

    it('clears halted AND delivers in the same call once the probe succeeds', async () => {
      const { flusher, unblock } = await haltedFlusher();
      unblock();
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1);

      await flusher.flush();

      // `agenfk hub flush` asked for a delivery: reporting recovery with a full
      // outbox and nothing sent would make the user run it twice.
      expect(flusher.getStatus().halted).toBe(false);
      expect(storage.hubOutboxCount()).toBe(0);
    });

    it('stays halted, and sends nothing, while the probe keeps failing', async () => {
      const { flusher, gets, posted } = await haltedFlusher({ pingOk: false });
      const postsBefore = posted.length;
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1);

      await flusher.flush();

      expect(gets.length).toBe(1);              // the probe was actually attempted
      expect(posted.length).toBe(postsBefore);  // and no delivery followed it
      expect(flusher.getStatus().halted).toBe(true);
      expect(storage.hubOutboxCount()).toBe(2);
    });

    it('does not un-halt on a 200 that is not our hub (captive portal login page)', async () => {
      const { flusher } = await haltedFlusher({ pingData: '<html>login</html>' });
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1);

      await flusher.flush();

      expect(flusher.getStatus().halted).toBe(true);
      expect(storage.hubOutboxCount()).toBe(2);
    });

    it('does not un-halt on a ping from a different org', async () => {
      const { flusher } = await haltedFlusher({ pingData: { ok: true, orgId: 'someone-else' } });
      vi.useFakeTimers();
      advance(MAX_BACKOFF_MS + 1);

      await flusher.flush();

      expect(flusher.getStatus().halted).toBe(true);
    });

    it('does not let flushNow bypass the halt', async () => {
      const { flusher, posted } = await haltedFlusher();
      const before = posted.length;

      await flusher.flushNow(500);

      expect(posted.length).toBe(before);
      expect(flusher.getStatus().halted).toBe(true);
    });
  });

  describe('stuck-but-not-halted visibility', () => {
    it('counts consecutive failures so the CLI can warn without a halt', async () => {
      queue(1);
      const { http } = makeHttp({ postImpl: async () => { throw httpError(404, 'Cannot POST /v1/events'); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 3);

      const status = flusher.getStatus();
      expect(status.halted).toBe(false);          // a moved hub URL no longer halts...
      expect(status.consecutiveFailures).toBe(3); // ...so this is the only signal left
      expect(status.nextRetryAt).toBeTruthy();
    });

    it('resets the failure count after a successful delivery', async () => {
      queue(1);
      let failing = true;
      const { http } = makeHttp({
        postImpl: async (body: any) => {
          if (failing) throw httpError(503, '');
          return ack(body?.events?.length ?? 0);
        },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 2);
      expect(flusher.getStatus().consecutiveFailures).toBe(2);
      failing = false;
      await flusher.flushNow(500);

      expect(flusher.getStatus().consecutiveFailures).toBe(0);
    });
  });
});
