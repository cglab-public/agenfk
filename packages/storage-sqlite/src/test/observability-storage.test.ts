import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import type { TokenEvent, IngestionState, Pr } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_DB = path.join(os.tmpdir(), `agenfk-sqlite-obs-storage-${process.pid}.sqlite`);

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function makeEvent(over: Partial<TokenEvent> = {}): TokenEvent {
  return {
    id: 'e-' + Math.random().toString(36).slice(2),
    ts: '2026-05-10T00:00:00.000Z',
    client: 'codex',
    sessionId: 'sess-1',
    turnId: 't-1',
    model: 'gpt-x',
    input: 100,
    cachedInput: 20,
    output: 50,
    reasoning: 10,
    total: 180,
    itemId: 'item-A',
    projectId: 'proj-1',
    sourcePath: '/p/sess.jsonl',
    sourceOffset: 0,
    ...over,
  };
}

describe('SQLiteStorageProvider observability methods', () => {
  let storage: SQLiteStorageProvider;
  beforeEach(async () => {
    cleanup();
    storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
  });
  afterEach(async () => {
    await storage.shutdown();
    cleanup();
  });

  describe('token events', () => {
    it('inserts and reads a single token event', async () => {
      const ev = makeEvent();
      await storage.insertTokenEvent(ev);
      const rows = await storage.queryTokenEvents({ itemId: 'item-A' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: ev.id,
        client: 'codex',
        input: 100,
        cachedInput: 20,
        output: 50,
        reasoning: 10,
        total: 180,
        sessionId: 'sess-1',
        sourcePath: '/p/sess.jsonl',
        sourceOffset: 0,
      });
    });

    it('queryTokenEvents filters by projectId, since, until, and client', async () => {
      await storage.insertTokenEvent(makeEvent({ id: 'a', ts: '2026-05-09T00:00:00.000Z', sourceOffset: 1 }));
      await storage.insertTokenEvent(makeEvent({ id: 'b', ts: '2026-05-10T00:00:00.000Z', sourceOffset: 2 }));
      await storage.insertTokenEvent(makeEvent({ id: 'c', ts: '2026-05-11T00:00:00.000Z', client: 'claude-code', sourceOffset: 3 }));
      await storage.insertTokenEvent(makeEvent({ id: 'd', projectId: 'proj-2', sourceOffset: 4 }));

      const inWindow = await storage.queryTokenEvents({ since: '2026-05-09T12:00:00.000Z', until: '2026-05-10T12:00:00.000Z' });
      expect(inWindow.map((e) => e.id).sort()).toEqual(['b', 'd']);

      const claude = await storage.queryTokenEvents({ client: 'claude-code' });
      expect(claude.map((e) => e.id)).toEqual(['c']);

      const proj1 = await storage.queryTokenEvents({ projectId: 'proj-1' });
      expect(proj1.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);

      const limited = await storage.queryTokenEvents({ projectId: 'proj-1', limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('insertTokenEvent rejects duplicates on (client, sourcePath, sourceOffset)', async () => {
      await storage.insertTokenEvent(makeEvent({ id: 'first', sourceOffset: 100 }));
      await expect(storage.insertTokenEvent(makeEvent({ id: 'second', sourceOffset: 100 }))).rejects.toThrow();
    });
  });

  describe('ingestion state', () => {
    it('returns null for unseen source paths', async () => {
      expect(await storage.getIngestionState('/never/seen')).toBeNull();
    });

    it('upserts and reads back', async () => {
      const s1: IngestionState = { sourcePath: '/p/a.jsonl', lastOffset: 100, lastRunAt: '2026-05-10T00:00:00Z' };
      await storage.setIngestionState(s1);
      expect(await storage.getIngestionState('/p/a.jsonl')).toEqual(s1);

      const s2: IngestionState = { sourcePath: '/p/a.jsonl', lastOffset: 250, lastRunAt: '2026-05-10T00:05:00Z' };
      await storage.setIngestionState(s2);
      expect(await storage.getIngestionState('/p/a.jsonl')).toEqual(s2);
    });
  });

  describe('PR registration', () => {
    function makePr(over: Partial<Pr> = {}): Pr {
      return {
        id: 'pr-' + Math.random().toString(36).slice(2),
        prNumber: 42,
        repo: 'foo/bar',
        itemId: 'item-A',
        openedAt: '2026-05-10T00:00:00Z',
        sizing: { epic: 0, story: 1, task: 2, bug: 0 },
        sizingDeclaredAt: '2026-05-10T00:00:00Z',
        ...over,
      };
    }

    it('inserts and looks up by repo+number and by itemId', async () => {
      const pr = makePr();
      const inserted = await storage.insertPr(pr);
      expect(inserted).toMatchObject({ prNumber: 42, repo: 'foo/bar' });

      const byNumber = await storage.getPrByRepoNumber('foo/bar', 42);
      expect(byNumber).toMatchObject({ id: pr.id, sizing: { epic: 0, story: 1, task: 2, bug: 0 } });

      const byItem = await storage.getPrsByItemId('item-A');
      expect(byItem).toHaveLength(1);
      expect(byItem[0].id).toBe(pr.id);
    });

    it('insertPr is idempotent on (repo, prNumber) — duplicate updates sizing instead of throwing', async () => {
      await storage.insertPr(makePr({ id: 'pr-1' }));
      // Re-call with same repo+number, different sizing → should refresh row, not error.
      const updated = await storage.insertPr(
        makePr({ id: 'pr-2', sizing: { epic: 1, story: 1, task: 5, bug: 0 } }),
      );
      const byNumber = await storage.getPrByRepoNumber('foo/bar', 42);
      expect(byNumber?.sizing).toEqual({ epic: 1, story: 1, task: 5, bug: 0 });
      expect(updated.sizing).toEqual({ epic: 1, story: 1, task: 5, bug: 0 });
    });

    it('updatePrSizing rewrites sizing + shadow + last_sizing_check_at', async () => {
      await storage.insertPr(makePr());
      const updated = await storage.updatePrSizing(
        'foo/bar',
        42,
        { epic: 0, story: 0, task: 9, bug: 1 },
        { epic: 0, story: 0, task: 7, bug: 0 },
      );
      expect(updated.sizing).toEqual({ epic: 0, story: 0, task: 9, bug: 1 });
      expect(updated.sizingShadow).toEqual({ epic: 0, story: 0, task: 7, bug: 0 });
      expect(updated.lastSizingCheckAt).toBeDefined();
    });

    it('returns null for unknown PRs', async () => {
      expect(await storage.getPrByRepoNumber('foo/bar', 999)).toBeNull();
      expect(await storage.getPrsByItemId('nonexistent')).toEqual([]);
    });
  });
});
