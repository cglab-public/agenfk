/**
 * Airlock learning storage (GH-294, TEL-3): one row per observed host, kept
 * apart from the capped decision log so the proposal is not limited to the
 * last few thousand verdicts. Observations merge as mergeHostObservation says
 * (core), in one transaction per batch, and the table is capped by last seen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dir: string;
let dbPath: string;
let storage: SQLiteStorageProvider;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-learning-'));
  dbPath = path.join(dir, 'db.sqlite');
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const R = '2026-10-27T12:00:00.000Z';

describe('airlock learned hosts', () => {
  it('starts empty', async () => {
    expect(await storage.listAirlockLearnedHosts()).toEqual([]);
  });

  it('merges observations of a host into one row, by source, and keeps it across a restart', async () => {
    await storage.recordAirlockHostObservations([
      { host: 'api.example.com', source: 'proxy', client: 'pi', itemId: 'card-1', ts: '2026-10-27T10:00:00.000Z', receivedAt: R },
      { host: 'api.example.com', source: 'tool', client: 'opencode', itemId: null, ts: '2026-10-27T11:00:00.000Z', receivedAt: R },
      { host: 'docs.example.org', source: 'tool', client: 'pi', ts: '2026-10-27T09:00:00.000Z', receivedAt: R },
    ]);
    await storage.recordAirlockHostObservations([
      { host: 'api.example.com', source: 'import', client: 'pi', ts: '2026-09-01T00:00:00.000Z', hits: 4, firstSeen: '2026-08-01T00:00:00.000Z', receivedAt: R },
    ]);
    await storage.shutdown();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
    const rows = await storage.listAirlockLearnedHosts();
    const api = rows.find(r => r.host === 'api.example.com');
    expect(api).toEqual({
      host: 'api.example.com',
      hits: { tool: 1, proxy: 1, import: 4 },
      firstSeen: '2026-08-01T00:00:00.000Z',
      lastSeen: '2026-10-27T11:00:00.000Z',
      receivedAt: R,
      clients: ['pi', 'opencode'],
      cards: ['card-1'],
    });
    expect(rows.map(r => r.host).sort()).toEqual(['api.example.com', 'docs.example.org']);
  });

  it('an import of the same logs twice does not double the count', async () => {
    const imp = { host: 'h.example.com', source: 'import' as const, client: 'pi', ts: '2026-09-01T00:00:00.000Z', hits: 3 };
    await storage.recordAirlockHostObservations([imp]);
    await storage.recordAirlockHostObservations([imp]);
    expect((await storage.listAirlockLearnedHosts())[0].hits).toEqual({ tool: 0, proxy: 0, import: 3 });
  });

  it('keeps at most the cap, forgetting the host RECEIVED longest ago, whatever date it reported', async () => {
    const cap = SQLiteStorageProvider.AIRLOCK_LEARNED_HOST_CAP;
    const batch = Array.from({ length: cap + 2 }, (_, i) => ({
      host: `h${i}.example.com`, source: 'tool' as const, client: 'pi',
      // The reported time runs backwards; only the receipt time orders retention.
      ts: new Date(Date.UTC(2030, 0, 1) - i * 1000).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    await storage.recordAirlockHostObservations(batch);
    const rows = await storage.listAirlockLearnedHosts();
    expect(rows.length).toBe(cap);
    const hosts = new Set(rows.map(r => r.host));
    expect(hosts.has('h0.example.com')).toBe(false);
    expect(hosts.has('h1.example.com')).toBe(false);
    expect(hosts.has(`h${cap + 1}.example.com`)).toBe(true);
  });

  it('a flood of future-dated agent-reported hosts never evicts a host the proxy vouched for (review finding 3)', async () => {
    await storage.recordAirlockHostObservations([
      { host: 'pkg.example.org', source: 'proxy', client: 'pi', ts: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const cap = SQLiteStorageProvider.AIRLOCK_LEARNED_HOST_CAP;
    const flood = Array.from({ length: cap + 10 }, (_, i) => ({
      host: `fake${i}.example.com`, source: 'import' as const, client: 'pi', hits: 1,
      ts: '9999-12-31T00:00:00.000Z', firstSeen: '9999-12-31T00:00:00.000Z',
      receivedAt: new Date(Date.UTC(2026, 5, 1) + i).toISOString(),
    }));
    await storage.recordAirlockHostObservations(flood);
    const rows = await storage.listAirlockLearnedHosts();
    const proxy = rows.find(r => r.host === 'pkg.example.org');
    expect(proxy?.hits.proxy).toBe(1);
    expect(rows.filter(r => r.hits.proxy === 0).length).toBe(cap);
    // The invented dates were clamped to when they arrived.
    expect(rows.every(r => r.lastSeen <= r.receivedAt)).toBe(true);
  });
});
