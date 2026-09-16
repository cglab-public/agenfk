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

afterEach(cleanup);

const OK: FleetSheetProps['depth'] = { allowed: true, reason: null };
const epic: FleetSheetItem = { id: 'epic', title: 'The epic', status: 'IN_PROGRESS' };
const kid = (id: string, claims?: string[]): FleetSheetItem =>
  ({ id, title: `Card ${id}`, status: 'TODO', parentId: 'epic', claims });

const show = (all: FleetSheetItem[], depth: FleetSheetProps['depth'] = OK, onLaunch = vi.fn()) => {
  render(<FleetSheet parent={epic} all={[epic, ...all]} depth={depth} onLaunch={onLaunch} onClose={vi.fn()} />);
  return onLaunch;
};

describe('the button', () => {
  it('counts what will run, not how many children exist', () => {
    /*
     * THE test. Two children want packages/ui, so one is held: the button must
     * say 3. A button that says four and launches three is a lie told by the
     * interface, and the count is the part a person trusts without checking.
     */
    show([kid('a', ['packages/ui/']), kid('b', ['packages/ui/x.ts']), kid('c', ['s/']), kid('d', ['t/'])]);
    expect(screen.getAllByTestId('fleet-row')).toHaveLength(4);
    expect(screen.getByTestId('fleet-launch'), 'the button promised a launch it cannot make')
      .toHaveTextContent('Launch 3');
  });

  it('launches exactly the ids the plan cleared, never the held one', () => {
    const onLaunch = show([kid('a', ['shared/']), kid('b', ['shared/x.ts']), kid('c', ['other/'])]);
    fireEvent.click(screen.getByTestId('fleet-launch'));
    const ids = onLaunch.mock.calls[0][0];
    expect(ids, 'a held child was launched anyway').toEqual(['a', 'c']);
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

describe('what the held rows say', () => {
  it('shows them rather than hiding them, because waiting is the design working', () => {
    /*
     * Hiding a held child turns a visible wait into an invisible one: the
     * count drops and nothing says why, which is the exact confusion this
     * sheet exists to prevent.
     */
    show([kid('a', ['shared/']), kid('b', ['shared/x.ts'])]);
    const rows = screen.getAllByTestId('fleet-row');
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.dataset.launch === 'false')).toHaveLength(1);
  });

  it('names the move for a sibling hold, which is to wait', () => {
    show([kid('a', ['shared/']), kid('b', ['shared/x.ts'])]);
    expect(screen.getByTestId('fleet-hold-reason')).toHaveTextContent(/waits for that one/i);
  });

  it('names the outside holder, since nobody will release on their own', () => {
    const outsider: FleetSheetItem = { id: 'outsider-99', title: 'Elsewhere', status: 'IN_PROGRESS', claims: ['shared/'] };
    show([outsider, kid('b', ['shared/x.ts'])]);
    expect(screen.getByTestId('fleet-hold-reason')).toHaveTextContent(/outsider/i);
  });

  it('says a claim it cannot read protects nothing', () => {
    show([kid('a', ['packages/**']), kid('b', ['x/'])]);
    expect(screen.getByTestId('fleet-hold-reason')).toHaveTextContent(/packages\/\*\*/);
    expect(screen.getByTestId('fleet-launch')).toHaveTextContent('Launch 1');
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
  it('reports the waiting ones, so the gap between rows and count is explained', () => {
    show([kid('a', ['shared/']), kid('b', ['shared/x.ts'])]);
    expect(screen.getByTestId('fleet-summary')).toHaveTextContent('1 ready · 1 waiting on a path');
  });

  it('does not mention waiting when nobody is', () => {
    show([kid('a', ['x/']), kid('b', ['y/'])]);
    expect(screen.getByTestId('fleet-summary').textContent).not.toMatch(/waiting/i);
  });
});

describe('an epic with nothing under it', () => {
  it('says so, and blames nobody', () => {
    // A blocked banner here would send somebody hunting a collision that does
    // not exist.
    show([]);
    expect(screen.getByText(/no children to dispatch/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fleet-blocked')).toBeNull();
    expect(screen.getByTestId('fleet-launch')).toBeDisabled();
  });
});
