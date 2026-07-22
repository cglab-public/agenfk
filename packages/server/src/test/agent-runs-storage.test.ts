/**
 * Storage layer for agent runs + transcript events (CGLAB-18a).
 * Behaviour-based: exercises the real SQLiteStorageProvider against an
 * in-memory DB — no source grepping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import type { AgentRun, RunEvent } from '@agenfk/core';

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: over.id ?? 'run-1',
    itemId: over.itemId ?? 'item-1',
    projectId: over.projectId ?? 'proj-1',
    step: over.step ?? 'CREATE_UNIT_TESTS',
    actor: over.actor ?? 'worker',
    harness: over.harness ?? 'pi',
    model: over.model ?? 'qwen3.6:27b',
    sessionId: over.sessionId ?? 'cglab18-tests',
    sourcePath: over.sourcePath ?? '/tmp/session.jsonl',
    status: over.status ?? 'running',
    verdict: over.verdict,
    startedAt: over.startedAt ?? '2026-07-21T10:00:00.000Z',
    endedAt: over.endedAt,
  };
}

describe('agent runs storage', () => {
  let storage: SQLiteStorageProvider;
  beforeEach(async () => {
    storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
  });

  it('creates and reads back a run', async () => {
    await storage.createAgentRun(makeRun());
    const got = await storage.getAgentRun('run-1');
    expect(got).not.toBeNull();
    expect(got!.itemId).toBe('item-1');
    expect(got!.model).toBe('qwen3.6:27b');
    expect(got!.status).toBe('running');
    expect(got!.sessionId).toBe('cglab18-tests');
  });

  it('lists runs filtered by item and by status', async () => {
    await storage.createAgentRun(makeRun({ id: 'run-1', itemId: 'A', status: 'done' }));
    await storage.createAgentRun(makeRun({ id: 'run-2', itemId: 'A', status: 'running', startedAt: '2026-07-21T10:05:00.000Z' }));
    await storage.createAgentRun(makeRun({ id: 'run-3', itemId: 'B', status: 'done' }));

    const forA = await storage.listAgentRuns({ itemId: 'A' });
    expect(forA.map(r => r.id)).toEqual(['run-1', 'run-2']); // ordered by startedAt ASC

    const doneA = await storage.listAgentRuns({ itemId: 'A', status: 'done' });
    expect(doneA.map(r => r.id)).toEqual(['run-1']);
  });

  it('updateAgentRun merges fields (status, verdict, endedAt)', async () => {
    await storage.createAgentRun(makeRun());
    const updated = await storage.updateAgentRun('run-1', {
      status: 'done', verdict: 'APPROVED', endedAt: '2026-07-21T10:03:00.000Z',
    });
    expect(updated.status).toBe('done');
    expect(updated.verdict).toBe('APPROVED');
    expect(updated.model).toBe('qwen3.6:27b'); // untouched field preserved
    const reread = await storage.getAgentRun('run-1');
    expect(reread!.status).toBe('done');
    expect(reread!.endedAt).toBe('2026-07-21T10:03:00.000Z');
  });

  it('getAgentRunBySession returns the most recent run for a session id', async () => {
    await storage.createAgentRun(makeRun({ id: 'old', sessionId: 's', startedAt: '2026-07-21T09:00:00.000Z' }));
    await storage.createAgentRun(makeRun({ id: 'new', sessionId: 's', startedAt: '2026-07-21T11:00:00.000Z' }));
    const got = await storage.getAgentRunBySession('s');
    expect(got!.id).toBe('new');
  });

  it('appends and lists run events ordered by seq', async () => {
    await storage.createAgentRun(makeRun());
    const ev = (seq: number, over: Partial<RunEvent> = {}): RunEvent => ({
      id: `e${seq}`, runId: 'run-1', seq, ts: '2026-07-21T10:00:0' + seq + '.000Z',
      lane: 'worker', kind: 'tool', tool: 'bash', text: 'npx vitest', ...over,
    });
    await storage.appendRunEvent(ev(2));
    await storage.appendRunEvent(ev(0, { lane: 'orchestrator', kind: 'dispatch', tool: undefined, text: 'go' }));
    await storage.appendRunEvent(ev(1, { kind: 'think', tool: undefined, text: 'planning' }));

    const events = await storage.listRunEvents('run-1');
    expect(events.map(e => e.seq)).toEqual([0, 1, 2]);
    expect(events[0].kind).toBe('dispatch');
    expect(events[2].tool).toBe('bash');
  });

  it('dedupes run events on (runId, seq)', async () => {
    await storage.createAgentRun(makeRun());
    const base: RunEvent = { id: 'e1', runId: 'run-1', seq: 0, ts: '2026-07-21T10:00:00.000Z', lane: 'worker', kind: 'note', text: 'first' };
    await storage.appendRunEvent(base);
    await storage.appendRunEvent({ ...base, id: 'e1-dup', text: 'second' }); // same (runId, seq)
    const events = await storage.listRunEvents('run-1');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('first'); // INSERT OR IGNORE keeps the first
  });
});
