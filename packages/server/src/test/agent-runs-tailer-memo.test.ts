/**
 * Tailer source-size memo (CGLAB-188).
 *
 * The tailer read the WHOLE session file and re-parsed every line on every 2s
 * poll, then discarded the events it had already seen. Work per tick was
 * proportional to the whole file, so a session's cost grew with how long it had
 * been running — a few MB of read + split + JSON.parse, per running agent,
 * every two seconds, forever.
 *
 * The memo skips the read when the file has not grown. The subtle half, and
 * what most of this file is about: it must NOT skip when the previous pass was
 * refused by the store, because that pass deliberately left its offset behind
 * and the retry has the SAME size.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { AgentRun } from '@agenfk/core';
import { tailRunsOnce, type RunEventBroadcast } from '../agent-runs/tailer';

const line = (o: unknown) => JSON.stringify(o);
const asst = (tool: string, cmd: string, tokens: number) => line({
  type: 'message', message: { role: 'assistant',
    content: [{ type: 'toolCall', id: 't', name: tool, arguments: { command: cmd, path: cmd } }],
    usage: { totalTokens: tokens } } });

async function seedRun(storage: SQLiteStorageProvider, over: Partial<AgentRun> = {}): Promise<string> {
  const run: AgentRun = {
    id: 'run-1', itemId: 'item-1', step: 'IN_PROGRESS', actor: 'worker',
    harness: 'pi', model: 'qwen3.6:27b', sessionId: 's', sourcePath: '/fake/s.jsonl',
    status: 'running', startedAt: '2026-07-21T10:00:00.000Z', ...over,
  };
  await storage.createAgentRun(run);
  return run.id;
}

/** A store that refuses every append, the way a momentarily unhappy one would. */
const refusing = (s: SQLiteStorageProvider): SQLiteStorageProvider => new Proxy(s, {
  get: (t, k) => (k === 'appendRunEvent' ? async () => null : Reflect.get(t, k).bind(t)),
}) as unknown as SQLiteStorageProvider;

describe('tailRunsOnce source-size memo', () => {
  let storage: SQLiteStorageProvider;
  let emitted: RunEventBroadcast[];
  const emit = (b: RunEventBroadcast) => emitted.push(b);

  beforeEach(async () => {
    storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
    emitted = [];
  });

  it('does not re-read or re-parse a file whose size has not changed', async () => {
    await seedRun(storage);
    const content = asst('bash', 'npx vitest', 100);
    let reads = 0;
    const deps = {
      readFile: () => { reads += 1; return content; },
      sizeOf: () => content.length,
      sizeCache: new Map<string, { path: string; size: number }>(),
      now: () => '2026-07-21T10:00:01.000Z',
    };

    const first = await tailRunsOnce(storage, emit, deps);
    expect(first).toHaveLength(1);
    expect(reads).toBe(1);

    const second = await tailRunsOnce(storage, emit, deps);
    expect(second).toHaveLength(0);
    // The whole point: the file was never touched on the second poll.
    expect(reads).toBe(1);
  });

  it('re-reads once the file grows and emits only the delta', async () => {
    await seedRun(storage);
    let content = asst('read', 'a.ts', 50);
    let reads = 0;
    const deps = {
      readFile: () => { reads += 1; return content; },
      sizeOf: () => content.length,
      sizeCache: new Map<string, { path: string; size: number }>(),
      now: () => '2026-07-21T10:00:02.000Z',
    };

    await tailRunsOnce(storage, emit, deps);
    expect(reads).toBe(1);

    content += '\n' + asst('bash', 'tsc -b', 80);
    const delta = await tailRunsOnce(storage, emit, deps);

    expect(reads).toBe(2);
    expect(delta).toHaveLength(1);
    expect(delta[0].seq).toBe(1);
  });

  it('still re-reads after a refused pass, even though the size is unchanged', async () => {
    /*
     * The refusal is WHY the retry exists. A refused pass stops the loop and
     * leaves the ingestion offset behind on purpose, so the next poll must run
     * the parser again — at, by definition, the same file size. Memoising that
     * pass would convert "retried forever until the store recovers" into "lost
     * permanently", which is the exact bug the offset work fixed.
     */
    await seedRun(storage);
    const content = asst('bash', 'npx vitest', 100);
    let reads = 0;
    const sizeCache = new Map<string, { path: string; size: number }>();
    const deps = {
      readFile: () => { reads += 1; return content; },
      sizeOf: () => content.length,
      sizeCache,
      now: () => '2026-07-21T10:00:01.000Z',
    };

    await tailRunsOnce(refusing(storage), emit, deps);
    expect(emitted).toEqual([]);
    // Nothing was consumed, so nothing may be memoised.
    expect(sizeCache.size).toBe(0);

    const second = await tailRunsOnce(storage, emit, deps);
    expect(reads).toBe(2);
    expect(second).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it('forgets the size of a run that is no longer running', async () => {
    const runId = await seedRun(storage);
    const content = asst('bash', 'x', 10);
    const sizeCache = new Map<string, { path: string; size: number }>();
    const deps = {
      readFile: () => content,
      sizeOf: () => content.length,
      sizeCache,
      now: () => '2026-07-21T10:00:01.000Z',
    };

    await tailRunsOnce(storage, emit, deps);
    expect(sizeCache.has(runId)).toBe(true);

    await storage.updateAgentRun(runId, { status: 'done' });
    await tailRunsOnce(storage, emit, deps);
    expect(sizeCache.has(runId)).toBe(false);
  });

  it('never skips when the size cannot be determined', async () => {
    /*
     * "Cannot tell" must not mean "unchanged". The default `sizeOf` is an
     * fs.statSync that throws for a file that is not there yet, and the whole
     * point of the guard is that an unreadable size falls through to reading —
     * skipping would silently drop the transcript.
     */
    await seedRun(storage);
    const content = asst('bash', 'npx vitest', 100);
    let reads = 0;
    const deps = {
      readFile: () => { reads += 1; return content; },
      sizeOf: () => undefined,
      sizeCache: new Map<string, { path: string; size: number }>(),
      now: () => '2026-07-21T10:00:01.000Z',
    };

    const first = await tailRunsOnce(storage, emit, deps);
    const second = await tailRunsOnce(storage, emit, deps);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    // Read both times: an unknown size is not evidence the file is unchanged.
    expect(reads).toBe(2);
  });

  it('re-reads when the run is re-pointed at a different file of the same size', async () => {
    /*
     * The size alone is not the file. PATCH /agent-runs/:id accepts a new
     * sourcePath, and a glob resolves to whichever match is newest — either can
     * swap the transcript between polls. A coincidental equal size must not
     * memoise the new file away.
     */
    await seedRun(storage);
    const contentA = asst('bash', 'aaa', 10);
    const contentB = asst('bash', 'bbb', 10); // identical byte length, different transcript
    expect(contentA.length).toBe(contentB.length);

    let path = '/fake/a.jsonl';
    let reads = 0;
    const deps = {
      resolveSource: () => path,
      readFile: (p: string) => { reads += 1; return p === '/fake/a.jsonl' ? contentA : contentB; },
      sizeOf: () => contentA.length,
      sizeCache: new Map<string, { path: string; size: number }>(),
      now: () => '2026-07-21T10:00:01.000Z',
    };

    await tailRunsOnce(storage, emit, deps);
    expect(reads).toBe(1);

    path = '/fake/b.jsonl';
    await tailRunsOnce(storage, emit, deps);
    /*
     * The memo must not swallow the new file. Whether the second file's events
     * are INGESTED is governed by the per-run count offset, which is not reset
     * when a run is re-pointed — a separate, pre-existing limitation (the
     * reviewer's note), not something this memo introduced. What this card owes
     * is the re-read.
     */
    expect(reads).toBe(2);
  });
});