/**
 * C3b (efcacdeb) — `agenfk verify --check <name>=pass|fail --check-note
 * <name>=<text>`, repeatable: the agent's report of the step's agent checks,
 * sent as `agentChecks`. A malformed flag is refused before anything is sent:
 * a typo must not turn into "not reported yet" from the server a minute later.
 */
import { describe, it, expect } from 'vitest';
import { parseCheckFlags } from '../agentChecksFlag';

describe('parseCheckFlags', () => {
  it('pairs each --check with its --check-note', () => {
    expect(parseCheckFlags(['docs=pass', 'lint-ok=fail'], ['docs=README has the mul line'])).toEqual({
      agentChecks: [
        { name: 'docs', outcome: 'pass', note: 'README has the mul line' },
        { name: 'lint-ok', outcome: 'fail' },
      ],
    });
  });

  it('nothing given, nothing sent', () => {
    expect(parseCheckFlags([], [])).toEqual({ agentChecks: [] });
  });

  it('keeps an = inside a note', () => {
    expect(parseCheckFlags(['docs=pass'], ['docs=a=b'])).toEqual({ agentChecks: [{ name: 'docs', outcome: 'pass', note: 'a=b' }] });
  });

  it.each([
    ['docs', /--check docs/],
    ['docs=maybe', /pass or fail/],
    ['Docs=pass', /not an agent check's name/],
    ['=pass', /not an agent check's name/],
  ])('refuses --check %s', (flag, why) => {
    const r = parseCheckFlags([flag], []);
    expect('error' in r && r.error).toMatch(why);
  });

  it('refuses the same check reported twice', () => {
    const r = parseCheckFlags(['docs=pass', 'docs=fail'], []);
    expect('error' in r && r.error).toMatch(/twice/);
  });

  // CGLAB-420: a note with no --check of its name answers one of the step's checks.
  it('sends a note for a check that is not reported as the answer to that check', () => {
    expect(parseCheckFlags(['docs=pass'], ['new-tests-born-green=pins add, which exists'])).toEqual({
      agentChecks: [{ name: 'docs', outcome: 'pass' }],
      checkAnswers: [{ id: 'new-tests-born-green', note: 'pins add, which exists' }],
    });
  });

  it('refuses an empty answer', () => {
    const r = parseCheckFlags([], ['red-is-assertion=']);
    expect('error' in r && r.error).toMatch(/needs some text/);
  });

  it('checks the server\'s 2000-character limit on the JOINED notes', () => {
    const r = parseCheckFlags(['docs=pass'], ['docs=' + 'a'.repeat(1500), 'docs=' + 'b'.repeat(600)]);
    expect('error' in r && r.error).toMatch(/2000/);
  });

  it('refuses a note with no name', () => {
    const r = parseCheckFlags(['docs=pass'], ['just text']);
    expect('error' in r && r.error).toMatch(/--check-note/);
  });
});
