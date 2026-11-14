/**
 * The card bar, and the session that has no card (96953f6a / CGLAB-266).
 *
 * Every control on that row answers a question about ONE worktree: which
 * branch, what changed, what is staged, open where in the editor. A herdr
 * attach resolves no worktree - that is the property that lets it adopt a
 * session started outside this app - so the row has nothing true to say about
 * it, and "no branch yet" about a session that can never have one is a fact
 * stated wrongly rather than a fact missing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { TerminalTab } from '../components/TerminalTab';
import { HERDR_AGENT_ID } from '../herdrTreeRows';

afterEach(cleanup);

const session = (agentId: string) => ({
  id: 's1',
  itemId: 'i1',
  title: agentId === HERDR_AGENT_ID ? 'herdr — catalog' : 'Adapter herdr',
  agentId,
  autoApprove: false,
  persist: false,
  openedAt: '2026-09-19T00:00:00.000Z',
  branchName: null,
});

const api = {
  spawn: async () => ({ sessionId: 'p1' }),
  write: async () => true,
  kill: async () => true,
  resize: async () => true,
  onData: () => () => {},
  onExit: () => () => {},
};

function mount(agentId: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
    <TerminalTab
      sessions={[session(agentId)] as never}
      sessionStates={new Map() as never}
      activeId="s1"
      api={api as never}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />
    </QueryClientProvider>,
  );
}

describe('an ordinary agent', () => {
  it('keeps the card bar, branch and all', () => {
    // The guard must be about attaching, not a blanket removal: sending a
    // command to the wrong branch is the mistake this bar exists to prevent.
    mount('claude-code');
    expect(screen.getByTestId('terminal-header')).toBeTruthy();
  });
});

describe('a herdr attach', () => {
  it('shows no card bar at all', () => {
    mount(HERDR_AGENT_ID);
    expect(screen.queryByTestId('terminal-header')).toBeNull();
  });

  it('never claims "no branch yet" about a session that cannot have one', () => {
    /*
     * The specific wrongness. That string is deliberate elsewhere - a card
     * whose worktree has not been created yet is worth knowing about BEFORE
     * you type - but an attach has no worktree to create, so the same words
     * describe a state that does not exist.
     */
    mount(HERDR_AGENT_ID);
    expect(screen.queryByText(/no branch yet/i)).toBeNull();
  });

  it('offers no worktree or editor controls', () => {
    // They act on a checkout. There is none.
    mount(HERDR_AGENT_ID);
    expect(screen.queryByText(/open in vs code/i)).toBeNull();
    expect(screen.queryByTestId('session-branch')).toBeNull();
  });
});
