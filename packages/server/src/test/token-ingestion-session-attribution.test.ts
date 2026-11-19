/**
 * GH-389: a turn is charged to the card its SESSION was on at the time (the
 * session_cards journal), not to whichever card in the project was activated
 * last - that guess charged one session's turns to another's card whenever two
 * agents worked in the same project. The time-based guess stays only for a turn
 * with no session id, the one case where there is nothing better.
 */
import { describe, it, expect } from 'vitest';
import type { TokenEvent } from '@agenfk/core';
import { attributeTokenEvent } from '../token-ingestion/watcher';

const project = { id: 'proj-1', name: 'p', projectRoot: '/repo', flowId: 'flow-1' };
const flow = { id: 'flow-1', steps: [{ name: 'TODO', isAnchor: true }, { name: 'IN_PROGRESS' }, { name: 'DONE', isAnchor: true }] };
// Card OTHER was activated most recently: the old time-only guess would pick it.
const items = [
  { id: 'MINE', projectId: 'proj-1', history: [{ toStatus: 'IN_PROGRESS', timestamp: '2026-11-19T09:00:00Z' }] },
  { id: 'OTHER', projectId: 'proj-1', history: [{ toStatus: 'IN_PROGRESS', timestamp: '2026-11-19T09:30:00Z' }] },
];

function storage(journal: Record<string, { itemId: string | null; projectId?: string } | null>) {
  return {
    async listProjects() { return [project]; },
    async getFlow() { return flow; },
    async listItems() { return items; },
    async sessionCardAt(client: string, sessionId: string, _ts: string) { return journal[`${client}/${sessionId}`] ?? null; },
  } as any;
}

const ev = (over: Partial<TokenEvent> = {}): TokenEvent => ({
  id: 'e', ts: '2026-11-19T10:00:00Z', client: 'claude-code', sessionId: 'sess-mine', model: 'm',
  input: 1, cachedInput: 0, output: 1, reasoning: 0, total: 2, cwd: '/repo/packages/x', sourcePath: '/p', sourceOffset: 0, ...over,
});

describe('attributeTokenEvent', () => {
  it('charges the card the session was on, even when another card was activated later', async () => {
    const e = ev();
    await attributeTokenEvent(storage({ 'claude-code/sess-mine': { itemId: 'MINE', projectId: 'proj-1' } }), e);
    expect(e).toMatchObject({ itemId: 'MINE', projectId: 'proj-1' });
  });

  it('a session with no journal row yet is charged to no card, only to the project', async () => {
    const e = ev();
    await attributeTokenEvent(storage({}), e);
    expect(e.itemId).toBeUndefined();
    expect(e.projectId).toBe('proj-1');
  });

  it('after the session ended its card, its turns are charged to no card', async () => {
    const e = ev();
    await attributeTokenEvent(storage({ 'claude-code/sess-mine': { itemId: null, projectId: 'proj-1' } }), e);
    expect(e.itemId).toBeUndefined();
  });

  it('takes the project from the journal when the cwd is outside every project root (a worktree elsewhere)', async () => {
    const e = ev({ cwd: '/tmp/worktrees/feat-x' });
    await attributeTokenEvent(storage({ 'claude-code/sess-mine': { itemId: 'MINE', projectId: 'proj-1' } }), e);
    expect(e).toMatchObject({ itemId: 'MINE', projectId: 'proj-1' });
  });

  it('only a turn without a session id falls back to the time-based guess', async () => {
    const e = ev({ sessionId: '' });
    await attributeTokenEvent(storage({}), e);
    expect(e.itemId).toBe('OTHER');
  });

  it('looks the session up under the event client, so ids from different harnesses never mix', async () => {
    const e = ev({ client: 'pi' });
    await attributeTokenEvent(storage({ 'claude-code/sess-mine': { itemId: 'MINE', projectId: 'proj-1' } }), e);
    expect(e.itemId).toBeUndefined();
  });
});
