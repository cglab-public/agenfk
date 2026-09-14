/**
 * Reading state off the rendered screen (CGLAB-193).
 *
 * The OSC path covers claude-code and codex. pi and gemini publish nothing in
 * the terminal title, so their state has to come from what is on screen — and
 * screen scraping is fragile, which is why most of these tests are about the
 * ways it can lie rather than the ways it works.
 */
import { describe, it, expect } from 'vitest';
import { activityFromScreen, SCREEN_RULES, TAIL_LINES } from '../screenActivity';

const lines = (...l: string[]) => l;

describe('pi', () => {
  it('is working while its spinner border is drawn', () => {
    expect(activityFromScreen('pi', lines('── ⠹ Working ─────────────'))).toBe('working');
  });

  it('is working on the literal it prints', () => {
    expect(activityFromScreen('pi', lines('Working...'))).toBe('working');
  });

  it('is unknown at a plain prompt', () => {
    // Not idle. Absence of a working marker is absence of evidence, and the
    // failure being replaced was a confident claim in the other direction.
    expect(activityFromScreen('pi', lines('❯ '))).toBe('unknown');
  });

  it('does not take a border that is not the working one', () => {
    // pi draws other boxes. A rule that matched any border would read every
    // frame as work.
    expect(activityFromScreen('pi', lines('── ⠹ Thinking ───────────'))).toBe('unknown');
    expect(activityFromScreen('pi', lines('─────────────────────────'))).toBe('unknown');
  });
});

describe('gemini', () => {
  it('is working while it offers to cancel', () => {
    expect(activityFromScreen('gemini', lines('  esc to cancel'))).toBe('working');
  });

  it('is blocked at a confirmation box', () => {
    expect(activityFromScreen('gemini', lines('│ Apply this change', '│ ❯ Yes'))).toBe('blocked');
  });

  it('prefers blocked over working when both are on screen', () => {
    /*
     * The case that decides the priority. gemini keeps printing "esc to cancel"
     * while a confirmation is up, so a naive first-match would call a question
     * "working" and the rail would never show that anyone is waiting on you.
     */
    expect(activityFromScreen('gemini', lines(
      '│ Allow execution of: rm -rf build',
      '│ ❯ Yes   No',
      '  esc to cancel',
    ))).toBe('blocked');
  });

  it('matches regardless of case', () => {
    expect(activityFromScreen('gemini', lines('Do you want to proceed?'))).toBe('blocked');
  });
});

describe('what it refuses to claim', () => {
  it('has no opinion about an agent with no rules', () => {
    // claude-code and codex are read from the OSC title instead; inventing
    // screen rules for them would be a second, weaker source disagreeing with
    // the first.
    for (const agent of ['claude-code', 'codex', 'shell', 'something-new']) {
      expect(activityFromScreen(agent, lines('Working...')), agent).toBe('unknown');
    }
  });

  it('will not let old scrollback answer for the present', () => {
    /*
     * THE reason this looks at a tail rather than the buffer. A confirmation
     * answered half an hour ago is still in the scrollback, and a rule reading
     * the whole screen would report the agent as blocked forever after the
     * first prompt it ever showed.
     */
    const ancient = 'do you want to proceed?';
    const since = Array.from({ length: TAIL_LINES + 4 }, (_, i) => `output line ${i}`);
    expect(activityFromScreen('gemini', [ancient, ...since])).toBe('unknown');
  });

  it('still sees a marker that is just inside the tail', () => {
    // The boundary in the other direction: cutting too aggressively would miss
    // a confirmation box whose header scrolled up a few lines.
    const recent = Array.from({ length: TAIL_LINES - 2 }, (_, i) => `line ${i}`);
    expect(activityFromScreen('gemini', ['│ Apply this change', ...recent])).toBe('blocked');
  });

  it('copes with an empty screen', () => {
    expect(activityFromScreen('pi', [])).toBe('unknown');
  });

  it('covers only the agents that publish nothing on OSC', () => {
    // Drift guard. If an agent gains a title rule it should LEAVE this table,
    // not sit in both with two sources of truth.
    expect(Object.keys(SCREEN_RULES).sort()).toEqual(['gemini', 'pi']);
  });
});
