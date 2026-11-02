/**
 * The flusher and the Airlock dataset (story 263d328e review, Codex gpt-6.1-sol 01a18385).
 *
 *  - F1: rows queued while the hub's switch was on are not sent once a sync has
 *    turned it off - but a process that has not heard from the hub yet (just
 *    restarted) keeps them, since nothing has said off.
 *  - F2: a batch is bounded by its bytes as well as its count: 500 dataset rows of
 *    up to 64 KB would be a body the hub refuses every time, holding up everything
 *    queued behind it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { removeTestDb } from './helpers/testDb';

const HUB_CONFIG = { url: 'http://hub.test', token: 't', orgId: 'acme' };

function makeHttp() {
  const posted: any[][] = [];
  const http: any = {
    post: async (_url: string, body: any) => {
      posted.push(body.events);
      return { status: 200, data: { ingested: body?.events?.length ?? 0 } };
    },
  };
  return { http, posted };
}

describe('the flusher and the Airlock dataset', () => {
  let dbPath: string;
  let storage: SQLiteStorageProvider;
  let flusherMod: typeof import('../hub/flusher');
  let syncMod: typeof import('../hub/airlockSync');

  beforeEach(async () => {
    // A fresh module pair: the switch is process state, and this is a fresh process.
    vi.resetModules();
    syncMod = await import('../hub/airlockSync');
    flusherMod = await import('../hub/flusher');
    dbPath = path.join(os.tmpdir(), `flusher-dataset-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });

  afterEach(async () => {
    await removeTestDb(dbPath, () => storage.shutdown());
  });

  let n = 0;
  const queue = (type: string, payload: unknown = {}) => {
    const id = `ev-${++n}`;
    storage.hubOutboxAppend(id, new Date().toISOString(), JSON.stringify({ eventId: id, orgId: 'acme', type, payload }));
    return id;
  };
  const sentTypes = (posted: any[][]) => posted.flat().map(e => e.type);

  it('F1: a process that has not heard from the hub yet sends the dataset rows it has queued', async () => {
    queue('airlock.dataset', { rowId: 'r-1' });
    queue('item.created');
    const { http, posted } = makeHttp();
    await new flusherMod.Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http).flushNow();
    expect(sentTypes(posted).sort()).toEqual(['airlock.dataset', 'item.created']);
    expect(storage.hubOutboxCount()).toBe(0);
  });

  it('F1: once a sync has turned the switch off, queued dataset rows and labels leave the outbox unsent', async () => {
    queue('airlock.dataset', { rowId: 'r-1' });
    queue('airlock.dataset-label', { rowId: 'r-1', label: { kind: 'approval' } });
    queue('item.created');
    // a sync that fails decides off
    const out = await syncMod.syncAirlockPolicy({ storage, hubConfig: HUB_CONFIG as any, fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as any, stateFile: path.join(os.tmpdir(), `airlock-state-${n}.json`) } as any);
    expect(out.outcome).toBe('error');
    expect(syncMod.airlockDatasetDecidedOff()).toBe(true);

    const { http, posted } = makeHttp();
    await new flusherMod.Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http).flushNow();
    expect(sentTypes(posted)).toEqual(['item.created']);
    expect(storage.hubOutboxCount()).toBe(0);
  });

  it('F2: a batch stops at the byte bound, and the rest go in the next', async () => {
    const big = 'x'.repeat(60 * 1024);
    for (let i = 0; i < 300; i++) queue('airlock.dataset', { rowId: `r-${i}`, args: { content: big } });
    const { http, posted } = makeHttp();
    await new flusherMod.Flusher(storage, HUB_CONFIG, 'inst', 30_000, 500, http).flushNow();
    expect(storage.hubOutboxCount()).toBe(0);
    expect(posted.length).toBeGreaterThan(1);
    for (const batch of posted) {
      expect(Buffer.byteLength(JSON.stringify({ events: batch }), 'utf8')).toBeLessThan(10 * 1024 * 1024);
    }
    expect(posted.flat()).toHaveLength(300);
  }, 60_000);

  it('F2: a single row larger than the bound still goes, alone', () => {
    const rows = [{ payload: 'x'.repeat(100) }, { payload: 'y' }];
    expect(flusherMod.withinBatchBytes(rows, 10)).toEqual([rows[0]]);
    expect(flusherMod.withinBatchBytes(rows, 1000)).toEqual(rows);
    expect(flusherMod.withinBatchBytes([], 10)).toEqual([]);
  });
});
