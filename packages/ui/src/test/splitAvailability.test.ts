/**
 * Two terminals, or a reason why not (CGLAB-192).
 *
 * *"Split is disabled with its reason on it rather than absent."* The failure
 * this guards is a control that disappears: the person tries the same thing
 * tomorrow, and nothing on screen ever told them what to change.
 *
 * The second failure is a reason that is true and useless. "Fewer than two
 * sessions" states the rule; "open a second terminal" states the move. Every
 * assertion below is about the second kind.
 */
import { describe, it, expect } from 'vitest';
import { splitAvailability, splitSurvivesPanel, PANE_FLOOR_PX, WORKTREE_PANEL_PX } from '../splitAvailability';

const at = (rowWidthPx: number, sessionCount = 2, worktreePanelOpen = false) =>
  splitAvailability({ sessionCount, rowWidthPx, worktreePanelOpen });

describe('when it fits', () => {
  it('allows two panes on a 1440 window', () => {
    // 1440 minus the 224 px sidebar is 1216, and two floors are 1184.
    expect(at(1216)).toEqual({ enabled: true, reason: null });
  });

  it('allows exactly at the floor, since the floor is the floor', () => {
    expect(at(PANE_FLOOR_PX * 2).enabled).toBe(true);
  });
});

describe('when it does not, and what it says', () => {
  it('refuses one terminal by naming the move, not the rule', () => {
    const r = at(1600, 1);
    expect(r.enabled).toBe(false);
    expect(r.reason, 'the reason stated the rule instead of the move').toMatch(/open a second terminal/i);
  });

  it('blames the git panel when the panel is the difference', () => {
    /*
     * THE useful case. The window is wide enough on its own, so the one thing
     * a person can change in a second is the panel - telling them to widen a
     * window they may not be able to widen is worse advice.
     */
    const r = at(PANE_FLOOR_PX * 2 + 10, 2, true);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/close the git panel/i);
  });

  it('blames the window when the window really is too small', () => {
    // Closing the panel would not help here, so saying so would send somebody
    // to do something that changes nothing.
    const r = at(800, 2, true);
    expect(r.reason).not.toMatch(/git panel/i);
    expect(r.reason).toMatch(/too narrow/i);
  });

  it('says how much width is needed, so the answer is checkable', () => {
    expect(at(800).reason).toContain(String(PANE_FLOOR_PX * 2));
  });

  it('gives ONE reason, never a list', () => {
    // Both objections hold here - one session AND no room. A control that
    // lists every objection reads as broken rather than unavailable.
    const r = at(400, 1, true);
    expect(r.reason).toMatch(/open a second terminal/i);
    expect(r.reason).not.toMatch(/narrow/i);
  });

  it('always gives a reason when it is disabled, and never when enabled', () => {
    /*
     * The invariant the whole feature rests on. A disabled control with a null
     * reason renders a greyed button that explains nothing - which is the
     * absent control this was meant to replace, wearing a different style.
     */
    const cases = [at(1216), at(1216, 1), at(400), at(700, 2, true), at(PANE_FLOOR_PX * 2)];
    for (const r of cases) {
      expect(Boolean(r.reason), 'disabled without a reason, or enabled with one').toBe(!r.enabled);
    }
  });
});

describe('what the split gives up to the panel', () => {
  it('keeps the split when the row can carry both', () => {
    expect(splitSurvivesPanel(PANE_FLOOR_PX * 2 + WORKTREE_PANEL_PX)).toBe(true);
  });

  it('drops the split rather than squeezing both panes under the floor', () => {
    /*
     * A terminal below its floor is not a smaller terminal - it is one that
     * wraps every line, which is worse than not being on screen. On a 1440
     * window the main column is 1216 and the panel is 288, leaving 928 for two
     * panes that need 1184.
     */
    expect(splitSurvivesPanel(1216), 'a 1440 window kept a split it cannot render').toBe(false);
  });

  it('does not fit three panes even at 1920, which is why there is no third', () => {
    // 1920 minus the sidebar is 1696; three floors are 1776.
    expect(1696).toBeLessThan(PANE_FLOOR_PX * 3);
  });
});
