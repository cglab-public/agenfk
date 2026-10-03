/**
 * The sheet, on screen (CGLAB-207).
 *
 * fleetPlan.test.ts proves the decision. This proves it is SHOWN - and pins
 * the two things a screen can get wrong that a pure function cannot: launching
 * something the plan held back, and hiding a held row so a visible wait becomes
 * an invisible one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FleetSheet, type FleetSheetItem, type FleetSheetProps } from '../components/FleetSheet';
import { guardTokens } from './helpers/tokenGuard';

afterEach(cleanup);
// CGLAB-434: every test here also proves the panel renders on tokens.
guardTokens();

const OK: FleetSheetProps['depth'] = { allowed: true, reason: null };
const epic: FleetSheetItem = { id: 'epic', title: 'The epic', status: 'IN_PROGRESS' };
const kid = (id: string): FleetSheetItem =>
  ({ id, title: `Card ${id}`, status: 'TODO', parentId: 'epic' });

const show = (
  all: FleetSheetItem[],
  depth: FleetSheetProps['depth'] = OK,
  onLaunch = vi.fn(),
  running: ReadonlySet<string> = new Set(),
) => {
  render(
    <FleetSheet
      parent={epic} all={[epic, ...all]} depth={depth}
      running={running} onLaunch={onLaunch} onClose={vi.fn()}
    />,
  );
  return onLaunch;
};

describe('the button', () => {
  it('holds a child the breaker has stopped, and does not count it', () => {
    /*
     * The dead wire (BUG b0bccf90): planFleet knew how to hold a stopped card,
     * and nothing ever handed it the count - so this row could not appear in
     * the shipped app while fleetPlan's own tests built the input by hand.
     */
    show([kid('a'), { ...kid('b'), failureCount: 3 }, kid('c')]);
    expect(screen.getByTestId('fleet-launch'), 'a stopped card was counted as launchable')
      .toHaveTextContent('Launch 2');
    expect(screen.getAllByTestId('fleet-hold-reason').map(e => e.textContent).join(' '))
      .toMatch(/3 consecutive failures/i);
  });

  it('cannot be pressed when nothing can start', () => {
    // "Launch 0" is a button somebody presses by mistake. This one refuses.
    const onLaunch = show([kid('a')], { allowed: false, reason: 'Two levels deep already.' });
    const button = screen.getByTestId('fleet-launch');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onLaunch).not.toHaveBeenCalled();
  });
});

describe('the ceiling', () => {
  it('says it once at the top, not on every row', () => {
    // Four rows repeating one reason reads as four problems where there is one.
    show([kid('a'), kid('b'), kid('c')], { allowed: false, reason: 'This card is 2 levels deep.' });
    expect(screen.getByTestId('fleet-blocked')).toHaveTextContent(/2 levels deep/);
    expect(screen.queryAllByTestId('fleet-hold-reason')).toHaveLength(0);
  });
});

describe('the summary line', () => {
  it('reports the held ones, so the gap between rows and count is explained', () => {
    show([kid('a'), kid('b')], OK, vi.fn(), new Set(['b']));
    expect(screen.getByTestId('fleet-summary')).toHaveTextContent('1 ready · 1 held');
  });

  it('does not mention held when nobody is', () => {
    show([kid('a'), kid('b')]);
    expect(screen.getByTestId('fleet-summary').textContent).not.toMatch(/held/i);
  });
});

describe('an epic with nothing under it', () => {
  it('says so, and blames nobody', () => {
    // A blocked banner here would send somebody hunting a cause that does not
    // exist.
    show([]);
    expect(screen.getByText(/no children to dispatch/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fleet-blocked')).toBeNull();
    expect(screen.getByTestId('fleet-launch')).toBeDisabled();
  });
});

describe('a child that already has a terminal', () => {
  it('is NOT counted, because launching would not start an agent for it', () => {
    /*
     * THE test for the promise this sheet rests on: the button counts what
     * will run.
     *
     * The dispatcher takes you to an existing terminal rather than starting a
     * second agent in the same worktree - correct behaviour, and a rule this
     * plan did not know. So "Launch 3" counted a card it was never going to
     * launch, and the person pressing it got two agents and no explanation for
     * the third. The count and the dispatch have to share every predicate, not
     * most of them.
     */
    show([kid('a'), kid('b'), kid('c')], OK, vi.fn(), new Set(['b']));
    expect(
      screen.getByRole('button', { name: /launch/i }).textContent,
      'it counted a card the dispatcher would not launch',
    ).toMatch(/2/);
  });

  it('is shown with the reason, not quietly dropped from the list', () => {
    // A child that vanishes is a count somebody has to reconcile by hand, and
    // the whole design here is that waiting is visible.
    show([kid('a'), kid('b')], OK, vi.fn(), new Set(['b']));
    expect(screen.getByText(/already has a terminal open/i)).toBeInTheDocument();
  });

  it('is not launched even if something else clears it', () => {
    const onLaunch = show([kid('a'), kid('b')], OK, vi.fn(), new Set(['b']));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(onLaunch).toHaveBeenCalledWith(['a']);
  });
});


/*
 * Reading the sheet before spending anything.
 *
 * Reported as "I did not understand what it is for, it is transparent, and
 * sometimes there is a warning". All three were legibility, not logic.
 */
describe('what the sheet says about itself', () => {
  it('names what pressing launch will do', () => {
    // The header carried "LAUNCH FLEET" and a card title; the only answer to
    // "what is this screen" was the button at the bottom.
    show([kid('a')]);
    expect(screen.getByTestId('fleet-what').textContent)
      .toMatch(/one agent per child card.*own worktree.*nothing runs until you launch/i);
  });

  it('is opaque, because it is read over the board', () => {
    // `bg-nav-surface` is a 72%-alpha token for the nav bar, which sits over a
    // blur. With no blur behind it, the board showed through the text.
    show([kid('a')]);
    const classes = screen.getByTestId('fleet-sheet').className;
    expect(classes).toContain('bg-surface');
    expect(classes).not.toContain('bg-nav-surface');
  });
});
