/**
 * GH-394: the turns charged to a project but to no card. `itemId: null` asks
 * for exactly those; leaving itemId out still means "any card or none".
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TokenEvent } from '@agenfk/core';
import { SQLiteStorageProvider } from '../index';

const TEST_DB = path.join(os.tmpdir(), `agenfk-no-card-query-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + s); } catch { /* absent */ } } };

let offset = 0;
const ev = (over: Partial<TokenEvent> = {}): TokenEvent => ({
  id: `e-${++offset}`, ts: '2026-11-19T10:00:00Z', client: 'claude-code', sessionId: 's1', model: 'claude-opus-5-5',
  input: 3, cachedInput: 0, output: 4, reasoning: 0, total: 7,
  sourcePath: '/p/s.jsonl', sourceOffset: offset, ...over,
});

describe('queryTokenEvents: turns on no card', () => {
  afterEach(cleanup);

  it('itemId null returns only the turns with no card, and combines with the project and time filters', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: TEST_DB });
    await storage.insertTokenEvent(ev({ id: 'carded', projectId: 'p1', itemId: 'card-1' }));
    await storage.insertTokenEvent(ev({ id: 'free', projectId: 'p1' }));
    await storage.insertTokenEvent(ev({ id: 'other-project', projectId: 'p2' }));
    await storage.insertTokenEvent(ev({ id: 'early', projectId: 'p1', ts: '2026-11-18T10:00:00Z' }));

    const none = await storage.queryTokenEvents({ itemId: null, projectId: 'p1', since: '2026-11-19T00:00:00Z' });
    const any = await storage.queryTokenEvents({ projectId: 'p1' });
    await storage.shutdown();

    expect(none.map(e => e.id)).toEqual(['free']);
    expect(any.map(e => e.id).sort()).toEqual(['carded', 'early', 'free']);
  });
});
