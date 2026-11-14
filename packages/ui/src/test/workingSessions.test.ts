/**
 * @vitest-environment jsdom
 *
 * The label and the press have to answer with the same session.
 *
 * Reported from the app: a child card whose work runs inside a parent session
 * said "Open" and then tried to SPAWN, which failed on a worktree the card did
 * not need. The label had matched the run's conversation to one of ours; the
 * press was still looking for a session whose itemId was this card.
 */
import { describe, it, expect } from 'vitest';
import { workingByItem, sessionForItem, adoptions, rememberedConversation } from '../workingSessions';

const parentSession = { id: 'sess-1', itemId: 'parent', agentSessionId: 'conv-1' };
const childRun = { itemId: 'child', state: 'running', hasTerminal: false, agentSessionId: 'conv-1' };

describe('what is working on a card', () => {
  it('calls a card ours when we hold its terminal', () => {
    expect(workingByItem([{ itemId: 'c1', state: 'idle', hasTerminal: true }], []))
      .toEqual({ c1: 'ours' });
  });

  it('calls a card ours when its run lives in a conversation we host', () => {
    // The subagent case: the run is on the child, the terminal is the parent's.
    expect(workingByItem([childRun], [parentSession])).toEqual({ child: 'ours' });
  });

  it('calls it elsewhere when nothing here hosts that conversation', () => {
    expect(workingByItem([childRun], [])).toEqual({ child: 'elsewhere' });
  });

  it('lets ours win over elsewhere for the same card', () => {
    const rows = [
      { itemId: 'c1', state: 'running', hasTerminal: false, agentSessionId: 'other' },
      { itemId: 'c1', state: 'running', hasTerminal: true },
    ];
    expect(workingByItem(rows, [])).toEqual({ c1: 'ours' });
  });

  it('says nothing about a card with no live row', () => {
    expect(workingByItem([{ itemId: 'c1', state: 'idle', hasTerminal: false }], [])).toEqual({});
  });

  it('ignores a session that has exited — it cannot host anything', () => {
    expect(workingByItem([childRun], [{ ...parentSession, exited: true }]))
      .toEqual({ child: 'elsewhere' });
  });
});

describe('which session to open', () => {
  it('prefers a terminal opened ON the card', () => {
    const own = { id: 'sess-2', itemId: 'child' };
    expect(sessionForItem('child', [childRun], [own, parentSession])).toBe('sess-2');
  });

  it('falls back to the session hosting the run’s conversation', () => {
    // The press that used to spawn.
    expect(sessionForItem('child', [childRun], [parentSession])).toBe('sess-1');
  });

  it('answers null when nothing here is showing that work', () => {
    expect(sessionForItem('child', [childRun], [])).toBeNull();
  });

  it('never answers with a session that has exited', () => {
    expect(sessionForItem('child', [childRun], [{ ...parentSession, exited: true }])).toBeNull();
    expect(sessionForItem('child', [], [{ id: 's', itemId: 'child', exited: true }])).toBeNull();
  });
});


/*
 * A row whose agent lives in another session.
 *
 * Reported twice, in two places: the project page's button and the sidebar
 * row. A subagent reports its run against the card it works on, while the
 * terminal it lives in belongs to the PARENT — so matching by card alone found
 * nothing and both surfaces offered to open a NEW terminal for work that was
 * already on screen.
 */
describe('opening a subagent’s row', () => {
  it('prefers the session hosting its conversation over starting one', () => {
    const rows = [{ itemId: 'child', state: 'running', hasTerminal: false, agentSessionId: 'conv-1' }];
    const sessions = [{ id: 'sess-parent', itemId: 'parent', agentSessionId: 'conv-1' }];
    expect(sessionForItem('child', rows, sessions)).toBe('sess-parent');
  });

  it('offers nothing to open when the conversation is somebody else’s', () => {
    const rows = [{ itemId: 'child', state: 'running', hasTerminal: false, agentSessionId: 'conv-9' }];
    const sessions = [{ id: 'sess-parent', itemId: 'parent', agentSessionId: 'conv-1' }];
    expect(sessionForItem('child', rows, sessions)).toBeNull();
  });
});


/*
 * A session that opened on a project, adopting the card its agent wrote.
 *
 * Reported from use: "I opened a terminal with no cards, it started creating
 * cards, and the project does not reference the pi session." Until the session
 * knows which card it produced, that work has no row in the tree, no run to
 * read and no card to attribute its tokens to.
 */
describe('adopting the card the agent created', () => {
  const session = { id: 'sess-1', agentSessionId: 'conv-1' };

  it('adopts the card of the first run naming its own conversation', () => {
    const rows = [{ itemId: 'new-card', state: 'running', agentSessionId: 'conv-1', title: 'Port the API' }];
    expect(adoptions([session], rows)).toEqual([
      { sessionId: 'sess-1', itemId: 'new-card', title: 'Port the API' },
    ]);
  });

  it('ignores a run from somebody else’s conversation', () => {
    // The tempting rule — "the first card created after this opened" — is
    // wrong the moment two agents work in one project, which is ordinary here.
    const rows = [{ itemId: 'other', state: 'running', agentSessionId: 'conv-9' }];
    expect(adoptions([session], rows)).toEqual([]);
  });

  it('leaves a session that already has a card alone', () => {
    const rows = [{ itemId: 'new-card', state: 'running', agentSessionId: 'conv-1' }];
    expect(adoptions([{ ...session, itemId: 'already' }], rows)).toEqual([]);
  });

  it('adopts nothing for a session that has exited', () => {
    const rows = [{ itemId: 'new-card', state: 'running', agentSessionId: 'conv-1' }];
    expect(adoptions([{ ...session, exited: true }], rows)).toEqual([]);
  });

  it('adopts nothing while no run has named the conversation', () => {
    // The agent has created the card but has not run the workflow for it yet.
    expect(adoptions([session], [{ itemId: 'x', state: 'running' }])).toEqual([]);
  });

  it('matches each session to its own conversation, with several open', () => {
    const rows = [
      { itemId: 'a', state: 'running', agentSessionId: 'conv-1' },
      { itemId: 'b', state: 'running', agentSessionId: 'conv-2' },
    ];
    expect(adoptions([session, { id: 'sess-2', agentSessionId: 'conv-2' }], rows)).toEqual([
      { sessionId: 'sess-1', itemId: 'a', title: undefined },
      { sessionId: 'sess-2', itemId: 'b', title: undefined },
    ]);
  });
});


/*
 * Picking up where the card left off.
 *
 * Reopening a terminal started a NEW conversation: only the restore path
 * carried the remembered id, so closing a tab and opening it again from the
 * card lost everything that had been said — while the dialog said "Continue".
 */
describe('the conversation a card already had', () => {
  const remembered = [
    { itemId: 'c1', agentId: 'claude-code', agentSessionId: 'conv-1' },
    { itemId: 'c1', agentId: 'pi', agentSessionId: 'conv-2' },
  ];

  it('finds the one for this card AND this agent', () => {
    expect(rememberedConversation('c1', 'pi', remembered)).toBe('conv-2');
  });

  it('does not hand one agent another’s transcript', () => {
    // Two agents can share a card; resuming inside somebody else's
    // conversation is not "continuing".
    expect(rememberedConversation('c1', 'codex', remembered)).toBeNull();
  });

  it('answers null for a card that never had one', () => {
    expect(rememberedConversation('c2', 'pi', remembered)).toBeNull();
  });

  it('ignores a row with no conversation recorded', () => {
    // Older rows, and agents that cannot be told their own id.
    expect(rememberedConversation('c3', 'pi', [{ itemId: 'c3', agentId: 'pi' }])).toBeNull();
  });
});
