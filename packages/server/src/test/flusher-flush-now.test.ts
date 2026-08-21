/**
 * Flusher.flushNow() synchronous-flush primitive.
 *
 * upgradeSync calls this after appending the `fleet:upgrade:started` event but
 * BEFORE spawning `agenfk upgrade` (which kills this process). Without flushNow,
 * the started event sits in the local outbox and the hub never sees the upgrade.
 *
 * Behaviour-based: construct a real Flusher against a real SQLite outbox with an
 * injected mock HTTP client and assert on the observable effect (outbox drained,
 * transport invoked, resilient to transport failure).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { Flusher } from '../hub/flusher';

const HUB_CONFIG = { url: 'http://hub.test', token: 't', orgId: 'acme' };

function makeHttp(impl?: (url: string, body: any) => Promise<any>) {
  const posted: any[] = [];
  const http: any = {
    post: async (url: string, body: any) => {
      posted.push({ url, body });
      // Mirrors the real POST /v1/events ack — the flusher refuses to delete
      // a batch unless the response carries the hub's {ingested} shape.
      return impl ? impl(url, body) : { status: 200, data: { ingested: body?.events?.length ?? 0 } };
    },
  };
  return { http, posted };
}

describe('Flusher.flushNow()', () => {
  let dbPath: string;
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flusher-flushnow-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      const f = `${dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function queue(orgId: string, n: number) {
    for (let i = 0; i < n; i++) {
      storage.hubOutboxAppend(`ev-${orgId}-${i}-${Math.random().toString(36).slice(2)}`,
        new Date().toISOString(),
        JSON.stringify({ orgId, type: 'fleet:upgrade:started', payload: { seq: i } }));
    }
  }

  it('drains the outbox synchronously and posts the queued events', async () => {
    queue('acme', 3);
    const { http, posted } = makeHttp();
    const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

    await flusher.flushNow();

    expect(storage.hubOutboxCount()).toBe(0); // fully drained
    expect(posted.length).toBeGreaterThan(0); // transport actually invoked
  });

  it('returns immediately when the outbox is already empty (no POST)', async () => {
    const { http, posted } = makeHttp();
    const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

    await flusher.flushNow();

    expect(posted).toHaveLength(0);
  });

  it('does not throw on transport failure and leaves the events in the outbox', async () => {
    queue('acme', 2);
    const { http } = makeHttp(async () => { throw new Error('network down'); });
    const flusher = new Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http);

    // Must resolve (not reject) even though every POST fails, and within the
    // timeout budget (a small timeout keeps the resilience loop bounded).
    await expect(flusher.flushNow(200)).resolves.toBeUndefined();
    expect(storage.hubOutboxCount()).toBe(2); // nothing lost — replays next boot
  });
});
