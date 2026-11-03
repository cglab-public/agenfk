/**
 * GH-346 — one hub loop, and no hub request that can hang it.
 *
 * The server used to run four timers against the hub. The one that pulled
 * flows, repo settings, Airlock and receipts did them one after another with a
 * bare `fetch` (no timeout), and scheduled its next tick only once the current
 * one finished. With the hub mid-redeploy, the installation applied no new
 * Airlock revision for 70 minutes, logged nothing, and only a restart cured it.
 *
 * Now there is one timer. Each tick starts every channel at once, a channel
 * still running from an earlier tick is skipped (never run twice at the same
 * time), and a channel that fails or never answers holds up nothing else.
 * Every hub request goes through `hubFetch`, which gives up after a deadline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';
import { startHubSync, DEFAULT_HUB_SYNC_INTERVAL_MS, type HubSyncHandle } from '../hub/hubSync';
import { hubFetch, hubRequestTimeoutMs, HUB_REQUEST_TIMEOUT_MS } from '../hub/hubRequest';
import { flowSyncChannels } from '../hub/flowSync';

const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('startHubSync (GH-346)', () => {
  let handle: HubSyncHandle | null = null;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs every channel on each tick, every 30 s by default', async () => {
    expect(DEFAULT_HUB_SYNC_INTERVAL_MS).toBe(30_000);
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    handle = startHubSync({ channels: [{ name: 'a', run: a }, { name: 'b', run: b }], firstDelayMs: 0 });

    await vi.advanceTimersByTimeAsync(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(a).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('a channel that never settles neither blocks the other channels nor the next tick, and is not started twice', async () => {
    const stuck = vi.fn(() => new Promise<void>(() => { /* never settles */ }));
    const airlock = vi.fn(async () => {});
    handle = startHubSync({ channels: [{ name: 'flows', run: stuck }, { name: 'airlock', run: airlock }], intervalMs: 1_000, firstDelayMs: 0 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(airlock).toHaveBeenCalledTimes(3);
    // Still in flight from the first tick: skipped, never run alongside itself.
    expect(stuck).toHaveBeenCalledTimes(1);
  });

  it('a channel that is in flight runs again once it settles', async () => {
    let release!: () => void;
    const slow = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { release = r; }))
      .mockImplementation(async () => {});
    handle = startHubSync({ channels: [{ name: 'upgrade', run: slow }], intervalMs: 1_000, firstDelayMs: 0 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slow).toHaveBeenCalledTimes(1);

    release();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it('a channel that throws logs one line naming it, and the others and the next tick still run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => { throw new Error('hub said 503'); });
    const syncThrow = vi.fn(() => { throw new Error('sync throw'); });
    const airlock = vi.fn(async () => {});
    handle = startHubSync({
      channels: [{ name: 'flows', run: boom }, { name: 'repoint', run: syncThrow }, { name: 'airlock', run: airlock }],
      intervalMs: 1_000, firstDelayMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(airlock).toHaveBeenCalledTimes(2);
    expect(boom).toHaveBeenCalledTimes(2);
    expect(syncThrow).toHaveBeenCalledTimes(2);
    const lines = error.mock.calls.map(c => c.join(' '));
    expect(lines.some(l => l.includes('[HUB_SYNC]') && l.includes('flows') && l.includes('hub said 503'))).toBe(true);
    expect(lines.some(l => l.includes('[HUB_SYNC]') && l.includes('repoint') && l.includes('sync throw'))).toBe(true);
  });

  it('waits firstDelayMs before the first tick', async () => {
    const a = vi.fn(async () => {});
    handle = startHubSync({ channels: [{ name: 'a', run: a }], intervalMs: 10_000, firstDelayMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(a).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('stop() ends the loop: no tick runs after it', async () => {
    const a = vi.fn(async () => {});
    handle = startHubSync({ channels: [{ name: 'a', run: a }], intervalMs: 1_000, firstDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('stop() before the first tick runs nothing at all', async () => {
    const a = vi.fn(async () => {});
    handle = startHubSync({ channels: [{ name: 'a', run: a }], intervalMs: 1_000, firstDelayMs: 500 });
    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a).not.toHaveBeenCalled();
  });
});

describe('hubFetch (GH-346)', () => {
  let server: http.Server;
  let base: string;
  const sockets = new Set<import('net').Socket>();

  beforeEach(async () => {
    // A hub that accepts the connection and never answers: what a target being
    // drained mid-deploy looks like from the installation.
    server = http.createServer(() => { /* never respond */ });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('gives up on a hub that never answers, instead of waiting for it', async () => {
    vi.stubEnv('AGENFK_HUB_REQUEST_TIMEOUT_MS', '200');
    const started = Date.now();
    await expect(hubFetch(`${base}/v1/airlock/policy`, { method: 'GET' })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('defaults to 15 s, and AGENFK_HUB_REQUEST_TIMEOUT_MS overrides it', () => {
    expect(HUB_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(hubRequestTimeoutMs()).toBe(15_000);
    vi.stubEnv('AGENFK_HUB_REQUEST_TIMEOUT_MS', '1234');
    expect(hubRequestTimeoutMs()).toBe(1234);
    vi.stubEnv('AGENFK_HUB_REQUEST_TIMEOUT_MS', 'nonsense');
    expect(hubRequestTimeoutMs()).toBe(15_000);
  });

  it('gives up on a hub that sends its headers and then drips the body forever', async () => {
    vi.stubEnv('AGENFK_HUB_REQUEST_TIMEOUT_MS', '300');
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"policy":');
      const drip = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(drip));
    });
    const started = Date.now();
    await expect(hubFetch(`${base}/v1/airlock/policy`).then(r => r.json())).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps a caller's own signal: its deadline, not the default, decides", async () => {
    vi.stubEnv('AGENFK_HUB_REQUEST_TIMEOUT_MS', '100');
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { setTimeout(() => res.end('{"ok":true}'), 400); });
    // A publish is allowed longer than the default: it must still get its answer.
    const res = await hubFetch(`${base}/v1/registry/flows/publish`, { method: 'POST', signal: AbortSignal.timeout(5_000) });
    expect(await res.json()).toEqual({ ok: true });
    // And a caller's abort still aborts.
    const ctl = new AbortController();
    const pending = hubFetch(`${base}/v1/receipts`, { method: 'POST', signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toThrow();
  });

  it('passes method, headers and body through and returns the answer', async () => {
    server.removeAllListeners('request');
    let seen: { method?: string; auth?: string; body: string } = { body: '' };
    server.on('request', (req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen = { method: req.method, auth: req.headers.authorization, body };
        res.setHeader('ETag', 'W/"11:0:d0"');
        res.end(JSON.stringify({ revision: 11 }));
      });
    });
    const res = await hubFetch(`${base}/v1/receipts`, { method: 'POST', headers: { Authorization: 'Bearer agk_x' }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"11:0:d0"');
    expect(await res.json()).toEqual({ revision: 11 });
    expect(seen).toEqual({ method: 'POST', auth: 'Bearer agk_x', body: '{"a":1}' });
  });
});

describe('flowSyncChannels: Airlock does not wait on the projects (GH-346)', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  let stateFile: string;
  const HUB_A = { url: 'http://hub.example.test', token: 'agk_test', orgId: 'org-a' };
  const policy = {
    schemaVersion: 1, mode: 'observe', models: [], appliesWhenModelUnknown: true,
    hosts: { allow: ['github.com'], deny: [], allowDownload: ['*'] },
    iocHosts: { revision: '0', hosts: [], updatedAt: null },
    rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
  };

  beforeEach(async () => {
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `hub-sync-loop-${id}.sqlite`);
    stateFile = path.join(os.tmpdir(), `airlock-state-${id}.json`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    for (const p of ['p1', 'p2', 'p3']) {
      await storage.createProject({ id: p, name: p, description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    }
  });
  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
    fs.rmSync(stateFile, { force: true });
  });

  it('names a separate channel for the projects, Airlock and receipts', () => {
    const names = flowSyncChannels({ storage, hubConfig: HUB_A, fetchImpl: vi.fn() as any, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile })
      .map(c => c.name);
    expect(names).toEqual(['flows', 'airlock', 'receipts']);
  });

  it('applies a new Airlock revision while every project request hangs', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('/v1/airlock/policy')) {
        return Promise.resolve({
          status: 200, ok: true,
          headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? 'W/"11:0:d0"' : null) },
          json: async () => ({ policy, revision: 11, iocRevision: 0, dataset: { enabled: false } }),
        });
      }
      return new Promise(() => { /* a hub that never answers the flow requests */ });
    });
    const channels = flowSyncChannels({ storage, hubConfig: HUB_A, fetchImpl: fetchImpl as any, emit: vi.fn(), etagCache: new Map(), airlockStateFile: stateFile });
    const handle = startHubSync({ channels, intervalMs: 60_000, firstDelayMs: 0 });
    try {
      for (let i = 0; i < 200 && (await storage.getAirlockPolicy('hub'))?.revision !== 11; i++) {
        await new Promise(r => setTimeout(r, 5));
      }
      expect((await storage.getAirlockPolicy('hub'))?.revision).toBe(11);
      expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/v1/flows/active'))).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
