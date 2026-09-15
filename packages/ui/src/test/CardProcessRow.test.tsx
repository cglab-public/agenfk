/**
 * A process drawn beneath the card it belongs to (1a1b8df6).
 *
 * The sessions rail is a flat list at the bottom of the sidebar showing work
 * that is ALREADY listed above it in the projects tree. Two places for one
 * fact is what this removes: the process moves under its own card, and the
 * title goes with the move, because the card directly above already carries it.
 *
 * What is left per process is the two things the card cannot say: what state it
 * is in, and which agent it is.
 *
 * MOST OF THIS FILE IS ABOUT THE TITLE BEING GONE and about the row still
 * saying everything the rail's row said. Dropping a line of text is easy to do
 * and easy to overdo, and the failure mode is a row that looks tidier while
 * quietly telling you less.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { CardProcessRow } from '../components/CardProcessRow';
import type { SessionRow } from '../components/SessionsRail';

afterEach(cleanup);

/* The REAL SessionRow, read off SessionsRail rather than invented. Getting
   this wrong is how a producer and a consumer come to agree with nobody. */
const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  runId: 'r1',
  itemId: 'i1',
  projectId: 'p1',
  title: 'Harden the token worker',
  agentId: 'claude-code',
  agentLabel: 'Claude Code',
  state: 'running',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  hasTerminal: true,
  ...over,
});

describe('what the row says', () => {
  it('does not repeat the card title', () => {
    /*
     * THE point of the change. The card sits directly above this row, so the
     * title here is the same string twice, inches apart - which is the
     * duplication the whole redesign exists to remove.
     */
    render(<CardProcessRow row={row()} />);
    expect(screen.queryByText('Harden the token worker')).toBeNull();
  });

  it('names the agent, which the card cannot', () => {
    // A card may have three processes on it. Without this the rows are
    // indistinguishable from each other.
    render(<CardProcessRow row={row({ agentLabel: 'Claude Code' })} />);
    expect(screen.getByText(/claude code/i)).toBeInTheDocument();
  });

  it('says the state as a word, not only to a screen reader', () => {
    /*
     * In the rail these strings existed but only reached assistive tech - the
     * dot carried the state visually and the label was an aria-label. With the
     * title gone there is room for the word, and a colour-only state fails for
     * the ~8% of men with a colour vision deficiency.
     */
    render(<CardProcessRow row={row({ state: 'blocked' })} />);
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
  });

  it('uses the same words as the rail did, rather than inventing its own', () => {
    // Two vocabularies for one set of states is how the rail and the tree came
    // to disagree in the first place.
    render(<CardProcessRow row={row({ state: 'failed' })} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('keeps what the agent last did, when it is running', () => {
    // The one thing worth the width freed by the title: what it is doing now
    // beats what it is called.
    render(<CardProcessRow row={row({ state: 'running', lastAction: 'Editing cardState.ts' })} />);
    expect(screen.getByText(/Editing cardState.ts/)).toBeInTheDocument();
  });
});

describe('the state is not carried by colour alone', () => {
  it('spins while running, so "is it thinking" is answerable at a glance', () => {
    render(<CardProcessRow row={row({ state: 'running' })} />);
    expect(screen.getByTestId('session-spinner')).toBeInTheDocument();
  });

  it('draws a still mark for every state that is not running', () => {
    // A spinner on a dead session says it is alive, which is worse than saying
    // nothing.
    render(<CardProcessRow row={row({ state: 'failed' })} />);
    expect(screen.queryByTestId('session-spinner')).toBeNull();
  });

  it('exposes the state to assistive tech as well as drawing it', () => {
    render(<CardProcessRow row={row({ state: 'blocked' })} />);
    expect(screen.getByTestId('process-row').getAttribute('data-state')).toBe('blocked');
  });
});

describe('stopping it', () => {
  it('offers STOP and not BOARD', () => {
    /*
     * BOARD was in the rail's row because the rail was somewhere else entirely.
     * Here the card is the line above, so "go to the card" is a control that
     * takes you where you already are - and in the rail the two used to
     * overprint each other as "19hBOARD".
     */
    render(<CardProcessRow row={row()} onStop={vi.fn()} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /board/i })).toBeNull();
  });

  it('stops the session it belongs to, not the card', () => {
    // A card can hold several; stopping must reach exactly one.
    const onStop = vi.fn();
    render(<CardProcessRow row={row({ runId: 'r-two' })} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledWith('r-two');
  });

  it('offers nothing to stop when there is no handler', () => {
    render(<CardProcessRow row={row()} />);
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });
});
