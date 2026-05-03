import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-outbox-test-${process.pid}.sqlite`);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('SQLiteStorageProvider hub_outbox', () => {
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

  it('appends and peeks events in occurred_at order', () => {
    storage.hubOutboxAppend('e2', '2026-05-03T10:00:01Z', '{"k":2}');
    storage.hubOutboxAppend('e1', '2026-05-03T10:00:00Z', '{"k":1}');
    storage.hubOutboxAppend('e3', '2026-05-03T10:00:02Z', '{"k":3}');
    const rows = storage.hubOutboxPeek();
    expect(rows.map(r => r.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(rows[0].attempts).toBe(0);
  });

  it('respects peek limit', () => {
    for (let i = 0; i < 10; i++) {
      storage.hubOutboxAppend(`e${i}`, `2026-05-03T10:00:0${i}Z`, '{}');
    }
    expect(storage.hubOutboxPeek(3)).toHaveLength(3);
  });

  it('append is idempotent on event_id (INSERT OR IGNORE)', () => {
    storage.hubOutboxAppend('dup', '2026-05-03T10:00:00Z', '{"v":1}');
    storage.hubOutboxAppend('dup', '2026-05-03T10:00:00Z', '{"v":2}');
    const rows = storage.hubOutboxPeek();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).v).toBe(1);
  });

  it('deletes a batch of events', () => {
    storage.hubOutboxAppend('a', '2026-05-03T10:00:00Z', '{}');
    storage.hubOutboxAppend('b', '2026-05-03T10:00:01Z', '{}');
    storage.hubOutboxAppend('c', '2026-05-03T10:00:02Z', '{}');
    storage.hubOutboxDelete(['a', 'c']);
    expect(storage.hubOutboxPeek().map(r => r.event_id)).toEqual(['b']);
  });

  it('hubOutboxDelete is a no-op for empty input', () => {
    storage.hubOutboxAppend('a', '2026-05-03T10:00:00Z', '{}');
    expect(() => storage.hubOutboxDelete([])).not.toThrow();
    expect(storage.hubOutboxCount()).toBe(1);
  });

  it('increments attempts and stores last_error', () => {
    storage.hubOutboxAppend('e1', '2026-05-03T10:00:00Z', '{}');
    storage.hubOutboxIncrementAttempt(['e1'], 'connection refused');
    storage.hubOutboxIncrementAttempt(['e1'], 'timeout');
    const [row] = storage.hubOutboxPeek();
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe('timeout');
  });

  it('hubOutboxCount reflects table size', () => {
    expect(storage.hubOutboxCount()).toBe(0);
    storage.hubOutboxAppend('a', '2026-05-03T10:00:00Z', '{}');
    storage.hubOutboxAppend('b', '2026-05-03T10:00:01Z', '{}');
    expect(storage.hubOutboxCount()).toBe(2);
    storage.hubOutboxDelete(['a']);
    expect(storage.hubOutboxCount()).toBe(1);
  });
});
