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
    const seqs = (await storage.listRunEvents(run.id)).map(e => e.seq);
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

/**
 * Telling the caller where the event landed (BUG 510df783).
 *
 * The position is assigned inside the INSERT, which was the right fix for a
 * real race — two events in flight used to compute the same number and the
 * second was dropped silently. What it left behind is that the caller never
 * learns the number: the object it handed over still carries
 * `seq: undefined`, and the server emits THAT object over the socket.
 *
 * Downstream, every live consumer compares events by `seq`, so a transcript
 * of undefineds collapses to a single event. A Claude Code session with the
 * Runs panel open shows one line and then nothing, for as long as it runs.
 */
describe('the position an appended event was given', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: `ev-${Math.random().toString(36).slice(2)}`,
    runId: 'run-1',
    ts: new Date().toISOString(),
    lane: 'worker' as const,
    kind: 'tool' as const,
    tool: 'Bash',
    text: 'npm test',
    ...over,
  });

  beforeEach(async () => { await storage.createAgentRun(sampleRun()); });

  it('comes back, instead of being kept inside the insert', async () => {
    // The whole bug in one assertion. Without this the caller cannot emit a
    // usable event, however correct the row in the database is.
    const seq = await storage.appendRunEvent(event() as never);
    expect(seq).toBe(0);
  });

  it('counts upward as events arrive', async () => {
    const a = await storage.appendRunEvent(event() as never);
    const b = await storage.appendRunEvent(event() as never);
    const c = await storage.appendRunEvent(event() as never);
    expect([a, b, c]).toEqual([0, 1, 2]);
  });

  it('gives back an explicit position unchanged', async () => {
    // The pi tailer knows the real order from the transcript, and that order
    // beats arrival order. What comes back must be what was asked for.
    expect(await storage.appendRunEvent(event({ seq: 41 }) as never)).toBe(41);
  });

  it('answers null when the row was already there', async () => {
    /*
     * The insert is INSERT OR IGNORE against UNIQUE(run_id, seq), so a repeat
     * writes nothing. Reporting a position for a row that was not written
     * would let the caller emit a duplicate to every open panel — and saying
     * "nothing happened" is the only honest answer.
     */
    const dup = event({ seq: 7 });
    expect(await storage.appendRunEvent(dup as never)).toBe(7);
    expect(await storage.appendRunEvent(dup as never)).toBeNull();
  });

  it('keeps numbering per run, not globally', async () => {
    // Two runs each start at zero; the UNIQUE constraint is on (run_id, seq).
    await storage.createAgentRun({ ...sampleRun(), id: 'run-2' });
    await storage.appendRunEvent(event() as never);
    expect(await storage.appendRunEvent(event({ runId: 'run-2' }) as never)).toBe(0);
  });

  it('agrees with what the transcript reads back', async () => {
    // Belt and braces: the number returned has to be the number stored, or
    // the socket and a refresh would disagree about the order.
    await storage.appendRunEvent(event() as never);
    const second = await storage.appendRunEvent(event() as never);
    const stored = await storage.listRunEvents('run-1');
    expect(stored[stored.length - 1].seq).toBe(second);
  });
});

/**
 * The payload, stored once rather than twice (review follow-up).
 *
 * `RunEvent.payload` is already a STRING by the time it reaches storage — the
 * route serialises it, and the auto-position branch says so in its own comment
 * and passes it through untouched. Thirty lines down, the explicit-position
 * branch called `JSON.stringify` on it again.
 *
 * That branch is the one the pi tailer always took, so a reader doing
 * JSON.parse got a string back instead of the object. The two branches
 * disagreed about the same field, and nothing noticed because nothing asserted
 * it either way.
 */
describe('the payload', () => {
  const withPayload = (seq: number | undefined, payload: string) => ({
    id: `p-${seq ?? 'auto'}-${Math.random().toString(36).slice(2)}`,
    runId: 'run-1', ts: new Date().toISOString(),
    lane: 'worker' as const, kind: 'tool' as const, tool: 'Bash',
    ...(seq === undefined ? {} : { seq }), payload,
  });

  beforeEach(async () => { await storage.createAgentRun(sampleRun()); });

  it('survives a round trip when the store assigned the position', async () => {
    await storage.appendRunEvent(withPayload(undefined, '{"cmd":"npm test"}') as never);
    const [e] = await storage.listRunEvents('run-1');
    expect(JSON.parse(e.payload as string)).toEqual({ cmd: 'npm test' });
  });

  it('survives it when the caller supplied the position', async () => {
    // The branch the pi tailer used to take every time. It stored
    // "{\\"cmd\\":\\"npm test\\"}" — a string of a string.
    await storage.appendRunEvent(withPayload(5, '{"cmd":"npm test"}') as never);
    const [e] = await storage.listRunEvents('run-1');
    expect(JSON.parse(e.payload as string)).toEqual({ cmd: 'npm test' });
  });

  it('stores the same bytes either way', async () => {
    // The point is not that each branch works, it is that they AGREE. Two
    // branches with two encodings is a field whose meaning depends on which
    // writer happened to reach it.
    await storage.appendRunEvent(withPayload(undefined, '{"a":1}') as never);
    await storage.appendRunEvent(withPayload(9, '{"a":1}') as never);
    const stored = await storage.listRunEvents('run-1');
    expect(stored[0].payload).toBe(stored[1].payload);
  });
});
