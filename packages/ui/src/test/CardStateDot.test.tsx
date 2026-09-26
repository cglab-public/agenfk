/**
 * @vitest-environment jsdom
 *
 * The one dot on a projects-tree row (CGLAB-164).
 *
 * Three states, and SHAPE carries each of them alongside hue — filled for an
 * agent working, a thick ring for a card that needs a person, a hairline ring
 * for one where nothing is running. Hue alone would be the whole signal for a
 * colour-blind reader, in a 7px mark, in a sidebar. Tailwind classes are what
 * jsdom can see of that, so the shape rules are asserted on the class list;
 * the assertions below are about which BOX MODEL each state uses, not about
 * the spelling of a colour.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { CardStateDot } from '../components/CardStateDot';
import type { CardState } from '../cardState';

afterEach(cleanup);

const dotFor = (state: CardState): HTMLElement => {
  cleanup();
  const { container } = render(<CardStateDot state={state} />);
  return container.querySelector('[data-card-state]') as HTMLElement;
};

describe('CardStateDot', () => {
  it('marks which of the three states it is drawing', () => {
    expect(dotFor('working').getAttribute('data-card-state')).toBe('working');
    expect(dotFor('needs-person').getAttribute('data-card-state')).toBe('needs-person');
    expect(dotFor('quiet').getAttribute('data-card-state')).toBe('quiet');
  });

  it('fills the dot only while an agent is working', () => {
    // Filled vs ring is the greyscale-survivable half of the signal.
    expect(dotFor('working').className).toMatch(/\bbg-emerald-500\b/);
    expect(dotFor('needs-person').className).toMatch(/\bbg-transparent\b/);
    expect(dotFor('quiet').className).toMatch(/\bbg-transparent\b/);
  });

  it('draws a heavier ring for needs-a-person than for quiet', () => {
    // Two rings that differ only in colour would collapse into one mark for a
    // reader who cannot separate amber from grey.
    //
    // The word-boundary spelling `/\bborder\b/` is WRONG here and review
    // caught it: `-` is a word boundary, so it matches inside
    // `border-ink-tertiary` and the quiet assertion passed with the width
    // class deleted. Whitespace-delimited is what "has the class" means.
    expect(dotFor('needs-person').className).toMatch(/(^|\s)border-2(\s|$)/);
    expect(dotFor('quiet').className).toMatch(/(^|\s)border(\s|$)/);
    expect(dotFor('quiet').className).not.toMatch(/(^|\s)border-2(\s|$)/);
  });

  it('pulses only for the state that is actually changing', () => {
    // Motion is an attention claim. A quiet row makes none.
    expect(dotFor('working').className).toMatch(/\banimate-pulse\b/);
    expect(dotFor('needs-person').className).not.toMatch(/\banimate-pulse\b/);
    expect(dotFor('quiet').className).not.toMatch(/\banimate-pulse\b/);
  });

  /*
   * There is deliberately NO test that the working mark carries
   * `motion-reduce:animate-none`. The class is there, and it is not something
   * a unit test can observe: jsdom applies no CSS, so the assertion passes
   * whether or not the variant works and fails on a cosmetic rename. This
   * repo already deleted one assertion of exactly that species, with the
   * reasoning written down — see "says it in words too, not only in colour"
   * in AppShell.test.tsx. Re-adding it here was a review finding.
   */

  it('gives the three states three different SHAPES, not one shape in three colours', () => {
    /*
     * Compared with every colour token stripped out, which is the whole claim.
     * Comparing the raw class strings — the first version of this test — could
     * not fail for the reason it names: three marks identical but for
     * `bg-emerald-500` / `bg-amber-500` / `bg-slate-500` are three distinct
     * strings, so it passed on precisely the design it exists to forbid.
     */
    const shapeOf = (state: CardState): string =>
      dotFor(state).className
        .split(/\s+/)
        // Anything naming a hue: bg-*, border-<colour>, ring-<colour>, and
        // the `/50` opacity suffixes. What survives is the box model.
        .filter(c => !/^(bg-|(border|ring)-(?!\d)[a-z]+-\d)/.test(c))
        .sort()
        .join(' ');

    const shapes = [shapeOf('working'), shapeOf('needs-person'), shapeOf('quiet')];
    expect(new Set(shapes).size, `two states share a shape: ${shapes.join(' | ')}`).toBe(3);
  });

  it('says the state in words, in the row text, for anyone not looking at a 7px dot', () => {
    // In the TEXT, not in an aria-label: the sidebar's own test reads the
    // row's textContent, and a `title` or aria-label on a non-focusable span
    // is a mouse-only fact that never reaches it.
    cleanup();
    render(<CardStateDot state="working" />);
    expect(screen.getByText(/an agent is working on this now/i)).toBeDefined();

    cleanup();
    render(<CardStateDot state="needs-person" />);
    expect(screen.getByText(/needs you/i)).toBeDefined();
  });

  it('keeps the live-dot hook the shell already tests against', () => {
    // Existing coverage queries this test id to assert the dot comes ON for an
    // event about this card and stays off for one about another. Renaming it
    // would quietly delete that coverage rather than fail.
    cleanup();
    render(<CardStateDot state="working" />);
    expect(screen.getByTestId('live-dot')).toBeDefined();

    cleanup();
    render(<CardStateDot state="quiet" />);
    expect(screen.queryByTestId('live-dot')).toBeNull();

    cleanup();
    render(<CardStateDot state="needs-person" />);
    expect(screen.queryByTestId('live-dot'), 'a blocked card is not a working one').toBeNull();
  });
});
