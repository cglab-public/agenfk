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
import type { SessionRow } from '../sessionRow';

afterEach(cleanup);

/* The REAL SessionRow, read off sessionRow.ts rather than invented. Getting
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

/*
 * A `describe('stopping it')` block sat here with three tests: that STOP was
 * offered, that it stopped the right session, and that it was absent without a
 * handler.
 *
 * The control is gone, reported by the user (8b019106). It did not stop
 * anything - the handler looked the run up among the open sessions and CLOSED
 * the terminal - so a label promising to interrupt an agent discarded the
 * session and its scrollback instead, at exactly the moment somebody most
 * wants the output.
 *
 * Deleted rather than reversed into "offers no STOP", because that assertion
 * would pass on any row that happens to lack the button for any reason,
 * including a rendering bug. The absence that matters is asserted once, below,
 * against the whole row.
 */
describe('what the row does NOT offer', () => {
  it('has no controls that act on the process', () => {
    /*
     * Both hover controls are gone and for different reasons. BOARD would have
     * taken you to the line directly above the one you are pointing at. STOP
     * closed the terminal.
     *
     * Asserted as "no buttons but the one that opens it", which is stronger
     * than naming the two that were removed: a third control added later
     * without a decision behind it fails here too.
     */
    render(<CardProcessRow row={row()} onOpen={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-testid', 'process-open');
  });
});
