import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import type { AgentRun } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_DB = path.join(os.tmpdir(), `agenfk-sqlite-runs-seq-${process.pid}.sqlite`);

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

let storage: SQLiteStorageProvider;
beforeEach(async () => {
  cleanup();
  storage = new SQLiteStorageProvider();
  await storage.init({ path: TEST_DB });
});
afterEach(async () => { await storage.shutdown(); cleanup(); });

const freshStorage = async () => storage;

const sampleRun = (): AgentRun => ({
  id: 'run-1',
  itemId: 'item-1',
  projectId: 'p-1',
  step: 'IN_PROGRESS',
  actor: 'worker',
  harness: 'claude-code',
  model: 'opus',
  status: 'running',
  startedAt: new Date().toISOString(),
} as AgentRun);


/**
 * Sequencing events that arrive at the same time.
 *
 * `seq` used to be computed in the route as `(await listRunEvents(id)).length`
 * — a read, an await, then a write. Two events in flight computed the SAME
 * number, and the insert is `INSERT OR IGNORE` against `UNIQUE(run_id, seq)`,
 * so the second was dropped SILENTLY: the API answered 201 and emitted
 * `run:event`, and the UI showed an event that vanished on the next refresh.
 *
 * It survived because the pi tailer is a serialized loop and never produced
 * two at once. The Claude Code hook makes concurrency the normal case.
 */
describe('concurrent run events', () => {
  it('keeps every event when several arrive at once', async () => {
    const storage = await freshStorage();
    const run = await storage.createAgentRun(sampleRun());
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        storage.appendRunEvent({
          id: `e-${n}`, runId: run.id, ts: new Date().toISOString(),
          lane: 'main', kind: 'tool', text: `event ${n}`,
        } as never)),
    );
    const events = await storage.listRunEvents(run.id);
    expect(events, 'events were silently dropped').toHaveLength(20);
  });

  it('gives each one a distinct position', async () => {
    const storage = await freshStorage();
    const run = await storage.createAgentRun(sampleRun());
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        storage.appendRunEvent({
          id: `e-${n}`, runId: run.id, ts: new Date().toISOString(),
          lane: 'main', kind: 'tool', text: `event ${n}`,
        } as never)),
    );
    const seqs = (await storage.listRunEvents(run.id)).map((e: { seq: number }) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('still honours an explicitly given position', async () => {
    // The pi tailer knows the real order from the transcript, and that order
    // is better than arrival order. An explicit seq must win.
    const storage = await freshStorage();
    const run = await storage.createAgentRun(sampleRun());
    await storage.appendRunEvent({
      id: 'e-explicit', runId: run.id, seq: 42, ts: new Date().toISOString(),
      lane: 'main', kind: 'tool', text: 'from a transcript',
    } as never);
    expect((await storage.listRunEvents(run.id))[0].seq).toBe(42);
  });
});
