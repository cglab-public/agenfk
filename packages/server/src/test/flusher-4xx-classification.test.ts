/**
 * Flusher 4xx classification and self-healing (BUG 1843e145).
 *
 * The flusher used to treat EVERY 4xx as an authoritative rejection: five such
 * cycles set `halted = true` and nothing outside the constructor ever cleared
 * it, so the install stopped delivering for the remaining lifetime of the API
 * server process. Off-VPN that fires routinely, because captive portals and
 * corporate proxies answer 403/407 — or 404 with an HTML body — instead of
 * failing the TCP connection.
 *
 * The discriminator is the BODY SHAPE, not the status code: a real hub always
 * answers 4xx with JSON carrying a string `error` field (see
 * packages/hub/src/auth/apiKey.ts:46 and packages/hub/src/routes/events.ts:103),
 * whereas an interposing proxy answers HTML or nothing.
 *
 * Behaviour-based: a real Flusher over a real SQLite outbox with an injected
 * mock transport; assertions are on observable state (halted flag, outbox
 * contents, whether the transport was invoked again).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { Flusher } from '../hub/flusher';

const HUB_CONFIG = { url: 'http://hub.test', token: 't', orgId: 'acme' };

/** An axios-shaped rejection, as the real transport produces. */
function httpError(status: number, data: any) {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status, data };
  e.isAxiosError = true;
  return e;
}

/**
 * Mock transport. `postImpl` drives POST /v1/events; `pingOk` drives the
 * GET /v1/ping recovery probe. Both record their invocations.
 */
function makeHttp(opts: { postImpl?: () => Promise<any>; pingOk?: boolean } = {}) {
  const posted: any[] = [];
  const gets: string[] = [];
  const http: any = {
    post: async (url: string, body: any) => {
      posted.push({ url, body });
      if (opts.postImpl) return opts.postImpl();
      return { status: 200, data: {} };
    },
    get: async (url: string) => {
      gets.push(url);
      if (opts.pingOk === false) throw httpError(503, '');
      return { status: 200, data: { ok: true, orgId: HUB_CONFIG.orgId } };
    },
  };
  return { http, posted, gets };
}

describe('Flusher 4xx classification', () => {
  let dbPath: string;
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flusher-4xx-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(() => {
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

  /** Drive `n` delivery attempts. flushNow() bypasses the backoff gate, so one
   *  call yields one cycle whenever the cycle ends in backoff. */
  async function attempts(flusher: Flusher, n: number) {
    for (let i = 0; i < n; i++) await flusher.flushNow(200);
  }

  describe('transport-level 4xx interposed by a proxy', () => {
    it('never halts on 403 with an HTML body, however many cycles run', async () => {
      queue(2);
      const { http } = makeHttp({
        postImpl: async () => { throw httpError(403, '<html><body>Access Denied</body></html>'); },
      });
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

    it('applies backoff so it does not hot-loop against the proxy', async () => {
      queue(1);
      const { http, posted } = makeHttp({ postImpl: async () => { throw httpError(403, '<html/>'); } });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await flusher.flushNow(200);
      const afterFirst = posted.length;
      await flusher.flush(); // gated by backoff — must not reach the transport

      expect(posted.length).toBe(afterFirst);
    });

    it('resumes delivery once the proxy is out of the way', async () => {
      queue(2);
      let blocked = true;
      const { http } = makeHttp({
        postImpl: async () => {
          if (blocked) throw httpError(403, '<html/>');
          return { status: 200, data: {} };
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

  describe('authoritative 4xx from the hub itself', () => {
    it('halts on a revoked-token 401 carrying the hub JSON error shape', async () => {
      queue(1);
      const { http } = makeHttp({
        postImpl: async () => { throw httpError(401, { error: 'Invalid or revoked token' }); },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 6);

      expect(flusher.getStatus().halted).toBe(true);
      expect(storage.hubOutboxCount()).toBe(1); // halted, not discarded
    });

    it('halts on a 400 rejection carrying the hub JSON error shape', async () => {
      queue(1);
      const { http } = makeHttp({
        postImpl: async () => { throw httpError(400, { error: 'Body must contain a non-empty events array' }); },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 6);

      expect(flusher.getStatus().halted).toBe(true);
    });

    it('surfaces the hub error message in status for `agenfk hub status`', async () => {
      queue(1);
      const { http } = makeHttp({
        postImpl: async () => { throw httpError(401, { error: 'Invalid or revoked token' }); },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      await attempts(flusher, 6);

      expect(flusher.getStatus().lastError).toContain('Invalid or revoked token');
    });

    it('halts exactly at the attempt threshold, not before', async () => {
      queue(1);
      const { http } = makeHttp({
        postImpl: async () => { throw httpError(401, { error: 'Invalid or revoked token' }); },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

      // An authoritative 4xx sets no backoff, so each flush() is exactly one
      // delivery attempt. HALT_AFTER_4XX_ATTEMPTS is 5.
      for (let i = 0; i < 4; i++) await flusher.flush();
      expect(flusher.getStatus().halted).toBe(false);

      await flusher.flush(); // 5th attempt
      expect(flusher.getStatus().halted).toBe(true);
    });
  });

  describe('self-healing out of the halted state', () => {
    async function haltedFlusher(pingOk: boolean) {
      queue(2);
      let rejecting = true;
      const { http, gets } = makeHttp({
        pingOk,
        postImpl: async () => {
          if (rejecting) throw httpError(401, { error: 'Invalid or revoked token' });
          return { status: 200, data: {} };
        },
      });
      const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);
      await attempts(flusher, 6);
      expect(flusher.getStatus().halted).toBe(true);
      return { flusher, gets, unblock: () => { rejecting = false; } };
    }

    it('probes /v1/ping while halted instead of going permanently silent', async () => {
      const { flusher, gets } = await haltedFlusher(true);

      await flusher.flush();

      expect(gets.some(u => u.includes('/v1/ping'))).toBe(true);
    });

    it('clears halted and drains the outbox once the probe succeeds', async () => {
      const { flusher, unblock } = await haltedFlusher(true);
      unblock();

      await flusher.flush();          // probe clears the halt
      await flusher.flushNow(500);    // delivery resumes

      expect(flusher.getStatus().halted).toBe(false);
      expect(storage.hubOutboxCount()).toBe(0);
    });

    it('stays halted while the probe keeps failing', async () => {
      const { flusher } = await haltedFlusher(false);

      await flusher.flush();

      expect(flusher.getStatus().halted).toBe(true);
      expect(storage.hubOutboxCount()).toBe(2);
    });
  });
});
