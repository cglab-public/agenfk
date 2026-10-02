/**
 * @vitest-environment jsdom
 *
 * Carrying the exit CODE up from the pane (CGLAB-194).
 *
 * `TerminalTab` used to write `onExited={() => onExited?.(session.id)}`: the
 * pane's only argument is the exit code, and that line threw it away and put
 * the session id in its place. Everything above therefore knew a process had
 * ended and could never know whether it ended BADLY.
 *
 * That was survivable while a dead session stayed in the rail as an idle row.
 * It stopped being survivable when dead rows began to be filtered out, because
 * a crashed agent then left no trace anywhere except the tab's own "Session
 * exited (1)" — and the rail's rule that a failure always stays was guarding a
 * state nothing in the app could produce.
 */
import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/*
 * The real pane boots xterm and talks to the desktop bridge. Neither is what
 * this file is about: the subject is the ONE line that relays the pane's
 * callback, so the pane is replaced by something that hands the callback back.
 */
let exitPane: ((code: number) => void) | undefined;
vi.mock('../components/TerminalPane', () => ({
  TerminalPane: (props: { onExited?: (code: number) => void }) => {
    exitPane = props.onExited;
    return <div data-testid="pane" />;
  },
}));

const { TerminalTab } = await import('../components/TerminalTab');

beforeEach(() => {
  exitPane = undefined;
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});
afterEach(cleanup);

/*
 * A provider, because the tab's top bar now asks git for the worktree counts.
 * Nothing here is about that query — `showWorktree` is off, so it never runs —
 * but the hook is called unconditionally, as a hook has to be.
 */
const renderTab = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>,
);

const props = (onExited: (sessionId: string, exitCode: number) => void) => ({
  sessions: [{
    id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code',
    autoApprove: false, persist: false, openedAt: new Date().toISOString(),
  }],
  activeId: 's1',
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNew: vi.fn(),
  onExited,
});

describe('a terminal process ending', () => {
  it('reports WHICH session and WHICH code', () => {
    // Both halves matter and the old code had exactly one of them. The session
    // id is required because two agents can share a card; the exit code is
    // required because a crash and an `exit` are not the same event.
    const onExited = vi.fn();
    renderTab(<TerminalTab {...props(onExited)} />);
    exitPane?.(1);
    expect(onExited).toHaveBeenCalledWith('s1', 1);
  });

  it('reports a clean exit as zero rather than swallowing it', () => {
    // The ordinary case must still arrive, and arrive distinguishable: zero is
    // what tells the shell above to call the row idle instead of failed.
    const onExited = vi.fn();
    renderTab(<TerminalTab {...props(onExited)} />);
    exitPane?.(0);
    expect(onExited).toHaveBeenCalledWith('s1', 0);
  });
});
