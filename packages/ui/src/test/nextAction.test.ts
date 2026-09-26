/**
 * The command, computed and never run (CGLAB-200).
 *
 * The screen shows a state and the person deduces the move. Showing the literal
 * argv removes the deduction without taking the decision from anybody.
 *
 * THE FAILURE THAT MATTERS IS A CONFIDENT WRONG COMMAND. A row that suggests
 * nothing costs a person some thinking; a row that suggests the wrong thing
 * gets copied, because the whole promise of this feature is that you do not
 * have to check it. So the unreachable case is the one most of this file is
 * about.
 */
import { describe, it, expect } from 'vitest';
import { nextAction, nextActionCommand } from '../nextAction';

const at = (state: Parameters<typeof nextAction>[0]['state'], hasTerminal = true) =>
  nextAction({ itemId: 'abcdef12-3456-7890-abcd-ef1234567890', state, hasTerminal });

describe('an agent we cannot reach', () => {
  it('says to look, and nothing else', () => {
    /*
     * THE test. Absence authorises neither release nor relaunch: releasing
     * hands its files to somebody else while it may still be writing them, and
     * relaunching duplicates work that may still be running.
     */
    const a = at('unverifiable');
    const cmd = nextActionCommand(a);
    expect(cmd, 'the suggestion was not an inspection').toMatch(/\bget\b/);
    expect(cmd, 'it suggested releasing an agent we cannot see').not.toMatch(/release|delete|remove/i);
    expect(cmd, 'it suggested relaunching work that may still be running').not.toMatch(/start|launch|retry|verify/i);
  });

  it('is marked read-only, so the safe move is the cheap one', () => {
    // If looking feels expensive, somebody reaches for a destructive command
    // to make the row go away.
    expect(at('unverifiable').readOnly).toBe(true);
  });

  it('says what it does not know, rather than guessing', () => {
    expect(at('unverifiable').intent).toMatch(/cannot reach/i);
    expect(at('unverifiable').intent).not.toMatch(/stopped|finished|crashed/i);
  });
});

describe('an agent that failed', () => {
  it('sends you to the transcript before any retry', () => {
    // Retrying without reading is how a failure repeats three times and then
    // trips a circuit breaker nobody understands.
    const a = at('failed');
    expect(a.intent).toMatch(/read the transcript/i);
    expect(a.readOnly).toBe(true);
  });

  it('still suggests something when this app owns no terminal for it', () => {
    // A hook-recorded run has a transcript and no terminal here. "Nothing to
    // suggest" would be wrong: there is plenty to look at.
    expect(nextActionCommand(at('failed', false))).not.toBe('');
  });
});

describe('an agent waiting on a person', () => {
  it('names the window, and offers no command at all', () => {
    /*
     * The one case where the move is not a command. A blocked agent is waiting
     * on its own prompt in its own terminal, and a CLI call here would send
     * somebody to the wrong window entirely.
     */
    const a = at('blocked');
    expect(a.argv).toEqual([]);
    expect(a.intent).toMatch(/open its terminal/i);
  });

  it('says plainly when the terminal is not ours to open', () => {
    expect(at('blocked', false).intent).toMatch(/does not own/i);
  });
});

describe('an agent that needs nothing', () => {
  it('suggests nothing while it is working', () => {
    // A command on a healthy row is noise, and noise on every row is how the
    // useful ones stop being read.
    expect(at('running')).toEqual({ intent: '', argv: [], readOnly: true });
  });

  it('suggests nothing when it is genuinely idle', () => {
    expect(at('idle').argv).toEqual([]);
  });
});

describe('the shape of the answer', () => {
  it('gives ONE action, never a list to choose from', () => {
    // Choosing between three commands is the deduction this exists to remove.
    for (const s of ['unverifiable', 'failed', 'blocked', 'running', 'idle'] as const) {
      const a = at(s);
      expect(Array.isArray(a.argv)).toBe(true);
      expect(typeof a.intent).toBe('string');
    }
  });

  it('always pairs a command with words explaining it', () => {
    /*
     * A bare argv is a thing to paste without understanding, which is the
     * opposite of the point: the reader should be able to decide NOT to run it.
     */
    for (const s of ['unverifiable', 'failed'] as const) {
      const a = at(s);
      expect(a.argv.length).toBeGreaterThan(0);
      expect(a.intent.length, `${s} offered a command with no explanation`).toBeGreaterThan(0);
    }
  });

  it('shortens the id the way the rest of this UI does', () => {
    expect(nextActionCommand(at('unverifiable'))).toContain('abcdef12');
    expect(nextActionCommand(at('unverifiable'))).not.toContain('ef1234567890');
  });

  it('never suggests anything that writes', () => {
    // Every action this module produces is read-only by design: it computes
    // and shows, and the person decides what to change.
    for (const s of ['unverifiable', 'failed', 'blocked', 'running', 'idle'] as const) {
      expect(at(s).readOnly, `${s} offered a write`).toBe(true);
    }
  });
});
