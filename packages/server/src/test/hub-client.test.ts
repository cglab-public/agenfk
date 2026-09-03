import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubClient, Flusher, loadHubConfig, hubConfigPath } from '../hub';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-client-test-${process.pid}.sqlite`);
const cleanupDb = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('HubClient', () => {
  let storage: SQLiteStorageProvider;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    cleanupDb();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
  });

  afterEach(async () => {
    await storage.shutdown();
    cleanupDb();
    process.env = { ...originalEnv };
  });

  it('is disabled when no config is present — but still outboxes with the pending-org sentinel', () => {
    // CGLAB-11: pre-login events used to be silently dropped; now they queue
    // with orgId '' and get stamped at the first boot with a config
    // (see hub-outbox-disconnected.test.ts for the full contract).
    const client = new HubClient('install-1', null);
    client.attachStorage(storage);
    expect(client.isEnabled).toBe(false);
    client.recordEvent({ type: 'item.created', payload: { id: 'x' } });
    expect(storage.hubOutboxCount()).toBe(1);
    expect(JSON.parse(storage.hubOutboxPeek(1)[0].payload).orgId).toBe('');
  });

  it('records events into the outbox when enabled', () => {
    const client = new HubClient('install-1', { url: 'http://hub.test', token: 't', orgId: 'org' });
    client.attachStorage(storage);
    expect(client.isEnabled).toBe(true);
    client.recordEvent({ type: 'item.created', itemId: 'i-1', payload: { title: 'demo' } });
    const rows = storage.hubOutboxPeek();
    expect(rows).toHaveLength(1);
    const ev = JSON.parse(rows[0].payload);
    expect(ev.type).toBe('item.created');
    expect(ev.itemId).toBe('i-1');
    expect(ev.installationId).toBe('install-1');
    expect(ev.orgId).toBe('org');
    expect(ev.actor.osUser).toBeDefined();
    expect(typeof ev.eventId).toBe('string');
    expect(typeof ev.occurredAt).toBe('string');
  });

  it('never throws if storage has not been attached', () => {
    const client = new HubClient('install-1', { url: 'http://hub.test', token: 't', orgId: 'org' });
    expect(() => client.recordEvent({ type: 'item.updated', payload: {} })).not.toThrow();
  });
});

describe('HubClient.reloadConfig', () => {
  it('adopts a token issued after construction', async () => {
    // The whole point: a revoked credential is baked into the Flusher's axios
    // instance at construction, so without this the outbox stays stranded until
    // the server restarts even though a valid token is already on disk.
    const client = new HubClient('install-1', { url: 'http://hub.test', token: 'old', orgId: 'org' });

    const changed = client.reloadConfig(() => ({ url: 'http://hub.test', token: 'new', orgId: 'org' }));

    expect(changed).toBe(true);
    expect(client.hubConfig).toEqual({ url: 'http://hub.test', token: 'new', orgId: 'org' });
  });

  it('reports no change when the config on disk is identical', async () => {
    const cfg = { url: 'http://hub.test', token: 't', orgId: 'org' };
    const client = new HubClient('install-1', { ...cfg });

    expect(client.reloadConfig(() => ({ ...cfg }))).toBe(false);
  });

  it('picks up a new url and org, not just the token', async () => {
    const client = new HubClient('install-1', { url: 'http://old.test', token: 't', orgId: 'old-org' });

    expect(client.reloadConfig(() => ({ url: 'http://new.test', token: 't', orgId: 'new-org' }))).toBe(true);
    expect(client.hubConfig).toEqual({ url: 'http://new.test', token: 't', orgId: 'new-org' });
  });

  it('goes disabled when the config has been removed', async () => {
    const client = new HubClient('install-1', { url: 'http://hub.test', token: 't', orgId: 'org' });

    expect(client.reloadConfig(() => null)).toBe(true);
    expect(client.isEnabled).toBe(false);
    expect(client.hubConfig).toBeNull();
  });

  it('becomes enabled when a config appears for a previously unconfigured client', async () => {
    const client = new HubClient('install-1', null);

    expect(client.reloadConfig(() => ({ url: 'http://hub.test', token: 't', orgId: 'org' }))).toBe(true);
    expect(client.isEnabled).toBe(true);
  });

  it('reports no change when there was and still is no config', async () => {
    const client = new HubClient('install-1', null);
    expect(client.reloadConfig(() => null)).toBe(false);
  });
});

describe('loadHubConfig', () => {
  const originalEnv = { ...process.env };
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hubcfg-'));

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('env vars override file', () => {
    process.env.AGENFK_HUB_URL = 'http://envhub';
    process.env.AGENFK_HUB_TOKEN = 'envtoken';
    process.env.AGENFK_HUB_ORG = 'envorg';
    expect(loadHubConfig()).toEqual({ url: 'http://envhub', token: 'envtoken', orgId: 'envorg' });
  });

  it('returns null when file is missing and env partial', () => {
    delete process.env.AGENFK_HUB_URL;
    delete process.env.AGENFK_HUB_TOKEN;
    delete process.env.AGENFK_HUB_ORG;
    // hubConfigPath() resolves against the CURRENT home (item 9c297075) — under
    // the vitest HOME pin that is the per-run sandbox, never the machine home.
    // Only check that loader returns null when env is empty AND the file is
    // unreadable.
    if (!fs.existsSync(hubConfigPath())) {
      expect(loadHubConfig()).toBeNull();
    }
  });
});

describe('Flusher', () => {
  let storage: SQLiteStorageProvider;

  beforeEach(async () => {
    cleanupDb();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
  });

  afterEach(async () => {
    await storage.shutdown();
    cleanupDb();
  });

  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      storage.hubOutboxAppend(`e${i}`, `2026-05-03T10:00:0${i}Z`, JSON.stringify({ id: `e${i}` }));
    }
  };

  it('deletes events on 2xx', async () => {
    seed(3);
    const http = axios.create();
    vi.spyOn(http, 'post').mockResolvedValue({ status: 200, data: { ingested: 3 } });
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'o' }, 'inst', 30_000, 500, http);
    await flusher.flush();
    expect(storage.hubOutboxCount()).toBe(0);
    expect(flusher.getStatus().lastFlushAt).not.toBeNull();
  });

  it('halts after repeated 4xx', async () => {
    seed(2);
    const http = axios.create();
    vi.spyOn(http, 'post').mockRejectedValue({ response: { status: 401, data: { error: 'unauthorized' } }, message: 'unauth' });
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'o' }, 'inst', 30_000, 500, http);
    for (let i = 0; i < 6; i++) {
      // Reset the soft-backoff window so each call actually executes.
      (flusher as any).nextEligibleAt = 0;
      await flusher.flush();
    }
    expect(flusher.getStatus().halted).toBe(true);
    expect(storage.hubOutboxCount()).toBe(2);
    expect(flusher.getStatus().lastError).toMatch(/401/);
  });

  it('retains and backs off on 5xx / network', async () => {
    seed(2);
    const http = axios.create();
    const spy = vi.spyOn(http, 'post').mockRejectedValue({ response: { status: 503, data: {} }, message: 'service unavailable' });
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'o' }, 'inst', 1_000, 500, http);
    await flusher.flush();
    expect(storage.hubOutboxCount()).toBe(2);
    // Second flush within backoff window is skipped (no extra HTTP call).
    await flusher.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(flusher.getStatus().halted).toBe(false);
  });

  it('flush is a no-op for empty outbox', async () => {
    const http = axios.create();
    const spy = vi.spyOn(http, 'post');
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'o' }, 'inst', 30_000, 500, http);
    await flusher.flush();
    expect(spy).not.toHaveBeenCalled();
    expect(flusher.getStatus().lastFlushAt).not.toBeNull();
  });
});
