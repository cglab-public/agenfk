/**
 * @vitest-environment jsdom
 *
 * The Sessions rail: every agent you have running, in one place (CGLAB-170).
 *
 * The sidebar's Sessions footer was a hardcoded sentence. This is what replaces
 * it, and the design that governs it is the CGLAB-170 artifact — four states,
 * each carrying its meaning in SHAPE as well as colour, because these are 8px
 * dots and colour alone fails for a colour-blind reader and in a greyscale
 * screenshot.
 *
 *   running — mid tool-call. Filled, slow pulse, subline names the tool.
 *   waiting — a permission prompt is up and nothing moves until you answer.
 *             Hollow amber ring, and it SORTS TO THE TOP: it is the only state
 *             that is costing you time right now.
 *   failed  — stays until dismissed, because a failure that disappears is a
 *             failure nobody sees.
 *   idle    — alive, no recent events. Dimmed hollow dot.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { SessionsRail, type SessionRow, PRODUCIBLE_STATES } from '../components/SessionsRail';

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  runId: 'r1',
  itemId: 'i1',
  title: 'Fix the flaky test',
  agentLabel: 'Claude Code',
  agentId: 'claude',
  state: 'running',
  lastAction: 'Bash · npx vitest run',
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  hasTerminal: true,
  ...over,
});

const renderRail = (rows: SessionRow[], props: Partial<React.ComponentProps<typeof SessionsRail>> = {}) =>
  render(<SessionsRail rows={rows} onOpen={() => {}} onStop={() => {}} {...props} />);

afterEach(() => cleanup());

describe('when nothing is running', () => {
  it('says so instead of showing an empty box', () => {
    renderRail([]);
    expect(screen.getByText(/none running/i)).toBeDefined();
  });

  it('does not show a count', () => {
    renderRail([]);
    expect(screen.queryByTestId('sessions-count')).toBeNull();
  });
});

describe('the states', () => {
  it('marks each row with its own state, not just a colour', () => {
    // The dots are 8px. Colour alone fails for a colour-blind reader and in a
    // greyscale screenshot, so state is in the shape and also readable here.
    renderRail([
      row({ runId: 'a', state: 'running' }),
      row({ runId: 'c', state: 'failed' }),
      row({ runId: 'd', state: 'idle' }),
    ]);
    const states = screen.getAllByTestId('session-dot').map(d => d.getAttribute('data-state'));
    expect(states.sort()).toEqual(['failed', 'idle', 'running']);
  });

  it('puts the one that needs a person first', () => {
    // A failure is the row that needs reading. Burying it under three running
    // agents is the failure this ordering prevents — the rail implies it is
    // showing you what needs you.
    //
    // This used to assert a 'waiting' state, which nothing in the app could
    // produce: the test handed it straight to the component, so it passed
    // while the state was unreachable.
    renderRail([
      row({ runId: 'a', state: 'running', title: 'Running one' }),
      row({ runId: 'b', state: 'idle', title: 'Idle one' }),
      row({ runId: 'c', state: 'failed', title: 'Failed one' }),
    ]);
    const titles = screen.getAllByTestId('session-title').map(t => t.textContent);
    expect(titles[0]).toMatch(/failed one/i);
  });

  it('keeps failures visible rather than dropping them', () => {
    // A failure that disappears is a failure nobody sees.
    renderRail([row({ state: 'failed', title: 'Broke' })]);
    expect(screen.getByText('Broke')).toBeDefined();
  });

  it('announces state to assistive tech, not only in pixels', () => {
    renderRail([row({ state: 'failed' })]);
    expect(screen.getByTestId('session-dot').getAttribute('aria-label')).toMatch(/failed/i);
  });
});

describe('what a row tells you without opening it', () => {
  it('names the agent', () => {
    renderRail([row({ agentLabel: 'Claude Code' })]);
    expect(screen.getByText(/claude code/i)).toBeDefined();
  });

  it('shows what it is doing right now', () => {
    // The subline is the last run:event. Seeing "Bash · npx vitest run" is the
    // difference between a status light and knowing whether to intervene.
    renderRail([row({ lastAction: 'Bash · npx vitest run' })]);
    expect(screen.getByText(/npx vitest run/)).toBeDefined();
  });

  it('does not show how long it has been going', () => {
    /*
     * Removed on use, with a screenshot: the BOARD button is positioned
     * absolutely in this same corner, so the two were drawn on top of each
     * other — "19hBOARD" on screen. Asked which to keep, the answer was the
     * button: how long a terminal has been open is not something anyone acts
     * on, and overlapping text reads as a broken app rather than a crowded one.
     *
     * Asserted rather than just deleted, so the row does not quietly grow it
     * back and recreate the collision.
     */
    renderRail([row({ startedAt: new Date(Date.now() - 125_000).toISOString() })]);
    expect(screen.queryByTestId('session-elapsed')).toBeNull();
  });

  it('counts what is running in the header', () => {
    renderRail([row({ runId: 'a' }), row({ runId: 'b', state: 'idle' })]);
    expect(screen.getByTestId('sessions-count').textContent).toMatch(/1/);
  });

  it('survives a row with no action reported yet', () => {
    // A run that has just started has emitted no events. It must render, not
    // collapse.
    renderRail([row({ lastAction: undefined })]);
    expect(screen.getByTestId('session-title')).toBeDefined();
  });
});

describe('clicking a session', () => {
  it('opens the run it belongs to', () => {
    const onOpen = vi.fn();
    renderRail([row({ runId: 'r9', itemId: 'i9' })], { onOpen });
    fireEvent.click(screen.getByTestId('session-title').closest('button')!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r9', itemId: 'i9' }));
  });

  it('says whether a terminal already exists for it', () => {
    // The caller needs this to focus an existing tab rather than spawn a second
    // agent in the same worktree — and, for a run recorded by the hook with no
    // PTY this app owns, to open the read-only Runs view instead of pretending
    // to attach.
    const onOpen = vi.fn();
    renderRail([row({ hasTerminal: false })], { onOpen });
    fireEvent.click(screen.getByTestId('session-title').closest('button')!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ hasTerminal: false }));
  });

  it('offers a stop that does not also open it', () => {
    // Stop sits inside the row. Without stopping propagation, stopping an agent
    // would also navigate you into the terminal you just killed.
    const onOpen = vi.fn();
    const onStop = vi.fn();
    renderRail([row({ runId: 'r9' })], { onOpen, onStop });
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledWith('r9');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not offer stop for something already finished', () => {
    renderRail([row({ state: 'failed' })]);
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });
});

describe('the running indicator', () => {
  it('spins while the agent is actually processing', () => {
    // A static dot says "a session exists". A spinner says "it is thinking
    // right now" — which is the question the rail is there to answer, and the
    // difference between glancing and having to open the terminal.
    renderRail([row({ state: 'running' })]);
    expect(screen.getByTestId('session-spinner')).toBeDefined();
  });

  it('does not spin for a session that is merely open', () => {
    // Idle means the process is alive and nothing is happening. Spinning there
    // would claim work that is not being done.
    renderRail([row({ state: 'idle' })]);
    expect(screen.queryByTestId('session-spinner')).toBeNull();
  });

  it('does not spin for a row that is not working', () => {
    renderRail([row({ runId: 'a', state: 'failed' }), row({ runId: 'b', state: 'idle' })]);
    expect(screen.queryByTestId('session-spinner')).toBeNull();
  });

  it('still carries the state in a static attribute', () => {
    // The spinner is motion, and motion is the first thing a reduced-motion
    // preference removes. State must survive without it.
    renderRail([row({ state: 'running' })]);
    expect(screen.getByTestId('session-dot').getAttribute('data-state')).toBe('running');
  });
});

describe('motion', () => {
  it('animates only the running row', () => {
    renderRail([row({ runId: 'a', state: 'running' }), row({ runId: 'b', state: 'idle' })]);
    expect(screen.getAllByTestId('session-spinner')).toHaveLength(1);
  });

  it('respects a reduced-motion preference', () => {
    // Not a style preference: for some people motion causes actual nausea.
    renderRail([row({ state: 'running' })]);
    expect(screen.getByTestId('session-spinner').className).toMatch(/motion-reduce:animate-none/);
  });
});

/**
 * Reaching the CARD, without taking the row's click away from the terminal.
 *
 * When the sidebar row started opening a terminal — asked for explicitly —
 * `focusItem` lost its only production caller, and with it went the board's
 * scroll-to-and-highlight effect and the tab switch that depended on it: real,
 * tested behaviour that nothing could reach any more.
 *
 * The row's click stays where it was asked to be. This is a second, quieter
 * affordance for the other question, so neither answer has to displace the
 * other.
 */
describe('going to the card on the board', () => {
  const row = {
    runId: 'r1', itemId: 'i1', title: 'A card', agentId: 'claude-code',
    agentLabel: 'Claude Code', state: 'running' as const,
    startedAt: new Date().toISOString(), hasTerminal: true,
  };

  it('offers it separately from the row itself', () => {
    const onReveal = vi.fn();
    render(<SessionsRail rows={[row]} onOpen={vi.fn()} onStop={vi.fn()} onReveal={onReveal} />);
    fireEvent.click(screen.getByRole('button', { name: /show .*on the board/i }));
    expect(onReveal).toHaveBeenCalledWith(row);
  });

  it('does not steal the row click, which still opens the terminal', () => {
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(<SessionsRail rows={[row]} onOpen={onOpen} onStop={vi.fn()} onReveal={onReveal} />);
    fireEvent.click(screen.getByTitle('A card'));
    expect(onOpen).toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
  });
});

/**
 * States the rail claims to have, and whether anything can produce them.
 *
 * The component's docblock named three properties as load-bearing: waiting
 * sorts to the top, failures stay until dismissed, and `lastAction` is "the
 * difference between a status light and knowing whether to step in". All three
 * were unreachable — the shell only ever emitted running or idle, and the runs
 * query filtered to `status: 'running'`, so a failed run could not even reach
 * the client.
 *
 * That is worse than a missing feature: the tests handed the states straight
 * to the component, so they passed while the app could never build one. A
 * docblock describing behaviour nobody can trigger is a lie that reads like
 * documentation.
 *
 * Two of the three are now real, because runs finally reach a terminal status.
 * The third is not, and is gone rather than pretended.
 */
describe('the states the app can actually produce', () => {
  it('shows a failed run as failed', () => {
    const rows = [{
      runId: 'r1', itemId: 'i1', title: 'Broke', agentId: 'claude-code',
      agentLabel: 'Claude Code', state: 'failed' as const,
      startedAt: new Date().toISOString(), hasTerminal: false,
    }];
    render(<SessionsRail rows={rows} onOpen={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByTestId('session-dot')).toHaveAttribute('data-state', 'failed');
  });

  it('sorts a failure above an idle row, because a failure needs reading', () => {
    const base = { startedAt: new Date().toISOString(), hasTerminal: false, agentLabel: 'X', agentId: 'pi' };
    const rows = [
      { ...base, runId: 'r1', itemId: 'i1', title: 'Quiet', state: 'idle' as const },
      { ...base, runId: 'r2', itemId: 'i2', title: 'Broke', state: 'failed' as const },
    ];
    render(<SessionsRail rows={rows} onOpen={vi.fn()} onStop={vi.fn()} />);
    const titles = screen.getAllByTestId('session-title').map(n => n.textContent);
    expect(titles[0]).toBe('Broke');
  });

  it('has no state the app cannot build', () => {
    // The check that keeps this honest as the component grows. Every state the
    // rail can render has to be one something upstream can actually emit.
    expect([...PRODUCIBLE_STATES].sort()).toEqual(['failed', 'idle', 'running']);
  });
});
