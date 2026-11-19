/**
 * GH-346 review: axios's `timeout` stops counting once a response's headers
 * arrive (follow-redirects clears its timer on 'response'); after that only the
 * socket's idle timeout applies. A hub that sends headers and drips the body
 * kept a flush in flight for as long as it dripped, and the hub loop then
 * skipped the `events` channel on every tick. Every axios request to the hub
 * now carries a signal with the whole-request deadline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import type { AddressInfo } from 'net';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';
import { Flusher } from '../hub/flusher';
import { reconcileRepointDirective } from '../hub/repointSync';

describe('axios hub requests are bounded over the whole response (GH-346)', () => {
  let hub: http.Server;
  let base: string;
  const sockets = new Set<import('net').Socket>();
  let storage: SQLiteStorageProvider;
  let dbPath: string;

  beforeEach(async () => {
    vi.stubEnv('AGENFK_HUB_REQUEST_TIMEOUT_MS', '300');
    // Headers at once, then a byte every 50 ms, never finishing.
    hub = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"accepted":');
      const drip = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(drip));
    });
    hub.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    dbPath = path.join(os.tmpdir(), `hub-flusher-deadline-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hub.close(() => r()));
    await removeTestDb(dbPath, () => storage.shutdown());
  });

  it('a flush against a dripping hub settles, and the event stays queued for the next tick', async () => {
    storage.hubOutboxAppend('e1', new Date().toISOString(), JSON.stringify({ orgId: 'acme', type: 'item.created' }));
    const flusher = new Flusher(storage, { url: base, token: 't', orgId: 'acme' }, 'inst');
    const started = Date.now();
    await flusher.flush();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(storage.hubOutboxCount()).toBe(1);
  });

  it('a repoint check against a dripping hub settles', async () => {
    const started = Date.now();
    await reconcileRepointDirective({
      hubUrl: base, hubToken: 't', orgId: 'acme', installationId: 'inst', envHubUrl: null,
      writeConfigImpl: vi.fn(), rebuildTransportImpl: vi.fn(async () => {}), recordEvent: vi.fn(), flushNow: vi.fn(async () => {}),
    } as any);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
