/**
 * The federation sync worker must not build a REAL HTTP transport under a test
 * runner.
 *
 * createHubApp starts startFederationSync unconditionally, and the worker used
 * to lazily construct `httpTransport()` whenever none was injected — which is
 * 70 of the 71 hub test files. Any test that stored a parent binding therefore
 * had a timer that would POST to whatever host the binding named, and those
 * bindings use real resolvable domains (parent.example.com, evil.example.com).
 *
 * This test points a binding at a loopback listener instead of the internet, so
 * it proves the socket is really opened without sending anything anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding } from '../services/federation/parentBinding';
import { startFederationSync } from '../services/federation/federationSync';

const SECRET = 'a'.repeat(64);
const TOKEN = 'fed_' + 'f'.repeat(64);

let db: HubDb;
let server: Server;
let hits: string[];
let port: number;

beforeEach(async () => {
  db = await openDb(':memory:');
  hits = [];
  server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
  // Stubbed rather than set in the test body: a throw before the cleanup line
  // would leak this into every later file in the serial worker, quietly
  // weakening the private-parent SSRF guard for all of them.
  vi.stubEnv('AGENFK_HUB_ALLOW_PRIVATE_PARENT', '1');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>(r => { server.close(() => r()); });
  await db.close();
});

const settle = () => new Promise<void>(r => setTimeout(r, 150));

describe('federation sync under a test runner', () => {
  it('does not dial the parent when no transport was injected', async () => {
    // Loopback stands in for parent.example.com: if the worker builds a real
    // transport, this listener records the ping.
    await writeParentBinding(db, SECRET, {
      parentUrl: `http://127.0.0.1:${port}`, token: TOKEN, childHubId: 'ch-1',
    });
    const stop = startFederationSync({ db, secretKey: SECRET, intervalMs: 10 });
    await settle();
    stop();
    expect(hits).toEqual([]);
  });

  it('still ticks normally when a transport IS injected', async () => {
    // The guard must disable only the real-transport path, or it would silently
    // stop every federation test that injects a fake.
    await writeParentBinding(db, SECRET, {
      parentUrl: 'https://parent.example.com', token: TOKEN, childHubId: 'ch-1',
    });
    let pings = 0;
    const stop = startFederationSync({
      db, secretKey: SECRET, intervalMs: 10,
      transport: {
        ping: async () => { pings++; return {}; },
        directives: async () => null,
        deliver: async () => ({}),
      } as any,
    });
    await settle();
    stop();
    expect(pings).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
});
