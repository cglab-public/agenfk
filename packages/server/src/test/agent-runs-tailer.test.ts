/**
 * Run tailer (CGLAB-18b). Behaviour-based: real storage + injected readFile;
 * asserts new pi events are appended & emitted once, idempotently, as the
 * session file grows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { AgentRun } from '@agenfk/core';
import { tailRunsOnce, type RunEventBroadcast } from '../agent-runs/tailer';

const line = (o: any) => JSON.stringify(o);
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

describe('tailRunsOnce', () => {
  let storage: SQLiteStorageProvider;
  let emitted: RunEventBroadcast[];
  const emit = (b: RunEventBroadcast) => emitted.push(b);
  beforeEach(async () => {
    storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
    emitted = [];
  });

  it('appends and emits new events, then is a no-op when nothing changed', async () => {
    const runId = await seedRun(storage);
    const content = [asst('bash', 'npx vitest', 100)].join('\n');
    const deps = { readFile: () => content, now: () => '2026-07-21T10:00:01.000Z' };

    const first = await tailRunsOnce(storage, emit, deps);
    expect(first).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ itemId: 'item-1', runId });
    expect(emitted[0].event).toMatchObject({ seq: 0, kind: 'tool', tool: 'bash' });

    // Second pass, identical file → nothing new appended or emitted.
    const second = await tailRunsOnce(storage, emit, deps);
    expect(second).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(await storage.listRunEvents(runId)).toHaveLength(1);
  });

  it('emits only the delta when the session file grows', async () => {
    const runId = await seedRun(storage);
    let content = [asst('read', 'a.ts', 50)].join('\n');
    const deps = { readFile: () => content, now: () => '2026-07-21T10:00:02.000Z' };

    await tailRunsOnce(storage, emit, deps);
    expect(emitted).toHaveLength(1);

    content = [asst('read', 'a.ts', 50), asst('bash', 'tsc -b', 80)].join('\n');
    const delta = await tailRunsOnce(storage, emit, deps);
    expect(delta).toHaveLength(1);
    expect(delta[0].seq).toBe(1);
    expect(emitted).toHaveLength(2);
    const events = await storage.listRunEvents(runId);
    expect(events.map(e => e.seq)).toEqual([0, 1]);
  });

  it('skips runs with no source file and missing files without throwing', async () => {
    await seedRun(storage, { id: 'no-src', sourcePath: undefined });
    await seedRun(storage, { id: 'missing', sourcePath: '/does/not/exist.jsonl' });
    const missingDeps = { readFile: (p: string) => { throw new Error('ENOENT ' + p); } };
    const appended = await tailRunsOnce(storage, emit, missingDeps);
    expect(appended).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('does not drop parser events when the orchestrator also appends via REST (mixed writers)', async () => {
    const runId = await seedRun(storage);
    // Orchestrator posts a dispatch event first (as the REST route would).
    await storage.appendRunEvent({ id: 'd0', runId, seq: 0, ts: 't', lane: 'orchestrator', kind: 'dispatch', text: 'go' });

    // Worker file has three parser events.
    let content = [asst('read', 'a.ts', 10), asst('bash', 'npx vitest', 20), asst('bash', 'tsc -b', 30)].join('\n');
    const deps = { readFile: () => content, now: () => 't' };
    const first = await tailRunsOnce(storage, emit, deps);
    expect(first).toHaveLength(3); // none dropped despite the pre-existing REST event

    const events = await storage.listRunEvents(runId);
    expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3]); // contiguous, appended after dispatch
    expect(events[0].kind).toBe('dispatch');
    expect(events.slice(1).map(e => e.kind)).toEqual(['tool', 'tool', 'tool']);

    // Re-tail unchanged → no-op.
    expect(await tailRunsOnce(storage, emit, deps)).toHaveLength(0);

    // File grows → only the new parser event is appended, after any events.
    content += '\n' + asst('read', 'b.ts', 40);
    const delta = await tailRunsOnce(storage, emit, deps);
    expect(delta).toHaveLength(1);
    expect(delta[0].seq).toBe(4);
  });

  it('ignores runs that are not running', async () => {
    await seedRun(storage, { id: 'done-run', status: 'done' });
    const appended = await tailRunsOnce(storage, emit, { readFile: () => asst('bash', 'x', 1) });
    expect(appended).toEqual([]);
  });
});
