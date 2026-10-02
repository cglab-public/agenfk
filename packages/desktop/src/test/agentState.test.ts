/**
 * @vitest-environment node
 *
 * Reading what the agent says it is doing (CGLAB-192).
 *
 * The rail marked a card live on ANY PTY output, and a terminal UI repaints its
 * own footer, so "running" never went out. The replacement is not a better
 * heuristic — it is a signal the agent publishes: Claude Code and Codex put a
 * spinner in the terminal TITLE while they work.
 *
 * Most of what follows is about the stream, not the glyphs. A PTY hands over
 * whatever arrived, not whole messages, so every sequence here is one that a
 * real read can be cut in half.
 */
import { describe, it, expect } from 'vitest';
import { TitleReader, activityFromTitle, TITLE_RULES } from '../main/agentState';

const ESC = '';
const BEL = '';
const osc = (n: number, body: string) => `${ESC}]${n};${body}${BEL}`;

describe('reading a title out of the stream', () => {
  it('finds one terminated by BEL', () => {
    const r = new TitleReader();
    expect(r.push(osc(0, '⣾ working'))).toBe('⣾ working');
  });

  it('finds one terminated by ST', () => {
    // Both terminators are legal and both appear in the wild; a reader that
    // knows only BEL silently sees no titles at all from an agent using ST.
    const r = new TitleReader();
    expect(r.push(`${ESC}]2;⣾ working${ESC}\\`)).toBe('⣾ working');
  });

  it('survives a sequence cut in half between chunks', () => {
    /*
     * The case that makes this a class and not a function. `ESC ]0;⣾ wor` and
     * `king BEL` is an ordinary pair of PTY reads, and a stateless parser sees
     * neither a title nor an error — it just never reports anything, which
     * looks exactly like an agent that never works.
     */
    const r = new TitleReader();
    expect(r.push(`${ESC}]0;⣾ wor`)).toBeNull();
    expect(r.push(`king${BEL}`)).toBe('⣾ working');
  });

  it('survives the introducer itself being split', () => {
    // ESC at the end of one read, `]` at the start of the next.
    const r = new TitleReader();
    expect(r.push(`some output${ESC}`)).toBeNull();
    expect(r.push(`]0;⣾ x${BEL}`)).toBe('⣾ x');
  });

  it('ignores the output around it', () => {
    const r = new TitleReader();
    expect(r.push(`hello\r\n${osc(0, '✳ idle')}more text`)).toBe('✳ idle');
  });

  it('reports only when the title CHANGES', () => {
    // A TUI rewrites its title on every repaint. Reporting each one would
    // flood the channel with the same value — the noise this replaces.
    const r = new TitleReader();
    expect(r.push(osc(0, '⣾ working'))).toBe('⣾ working');
    expect(r.push(osc(0, '⣾ working'))).toBeNull();
    expect(r.push(osc(0, '✳ idle'))).toBe('✳ idle');
  });

  it('takes the last of several in one chunk', () => {
    const r = new TitleReader();
    expect(r.push(osc(0, '⣾ a') + osc(0, '✳ b'))).toBe('✳ b');
  });

  it('ignores OSC 1, which sets the icon name and not the title', () => {
    const r = new TitleReader();
    expect(r.push(osc(1, '⣾ not a title'))).toBeNull();
    expect(r.current()).toBeNull();
  });

  it('ignores an OSC that is not about the title at all', () => {
    // OSC 8 is a hyperlink; agents emit these. Treating one as a title would
    // put a URL where a state glyph belongs.
    const r = new TitleReader();
    expect(r.push(`${ESC}]8;;https://example.test${BEL}`)).toBeNull();
  });

  it('does not grow without limit on an unterminated sequence', () => {
    /*
     * Two bytes that happen to be ESC and `]` in a stream that never
     * terminates would otherwise be held for the life of the session. Titles
     * are short; a megabyte of pending is a leak, not a sequence.
     */
    const r = new TitleReader();
    r.push(`${ESC}]0;`);
    for (let i = 0; i < 50; i += 1) r.push('x'.repeat(1000));
    // Still functional afterwards: the guard must drop the junk, not the reader.
    expect(r.push(osc(0, '✳ fine'))).toBe('✳ fine');
  });
});

describe('what a title means', () => {
  it('reads the Braille spinner as working', () => {
    // Claude Code up to 2.1.227.
    expect(activityFromTitle('claude-code', '⣾ Editing agentState.ts')).toBe('working');
  });

  it('reads the half-circle spinner as working', () => {
    // The 2.1.228 busy spinner. Both are kept because users run both.
    expect(activityFromTitle('claude-code', '◐ Editing agentState.ts')).toBe('working');
  });

  it('reads the idle glyph as idle', () => {
    expect(activityFromTitle('claude-code', '✳ agenfk')).toBe('idle');
  });

  it('will not call a plain title idle', () => {
    // The whole failure being replaced was a confident wrong claim. "No glyph"
    // is not evidence of rest — it is absence of evidence.
    expect(activityFromTitle('claude-code', 'agenfk — main')).toBe('unknown');
  });

  it('will not read a glyph that is not at the front', () => {
    // A Braille character in the middle of a title is a filename, not a state.
    expect(activityFromTitle('claude-code', 'editing ⣾.txt')).toBe('unknown');
  });

  it('has no opinion about an agent that publishes nothing', () => {
    /*
     * pi and gemini set no OSC title at all — herdr matches their screen text
     * instead. A rule here would be invented, and `unknown` has to mean "no
     * opinion" rather than "idle", or half the agents would read as asleep.
     */
    for (const agent of ['pi', 'gemini', 'shell', 'something-new']) {
      expect(activityFromTitle(agent, '⣾ working'), agent).toBe('unknown');
      expect(activityFromTitle(agent, null), agent).toBe('unknown');
    }
  });

  it('has no opinion when there is no title yet', () => {
    expect(activityFromTitle('claude-code', null)).toBe('unknown');
  });

  /*
   * Codex is not Claude with a different name — and assuming it was is exactly
   * why this shipped broken for it. Reported from use: "o claude funcionou
   * perfeito, o codex não". Every case below is one of the three differences.
   */
  it('reads the codex spinner wherever it sits in the title', () => {
    // NOT anchored. This is the one that made codex see nothing: Claude puts
    // its spinner first, codex does not.
    expect(activityFromTitle('codex', '⠙ working')).toBe('working');
    expect(activityFromTitle('codex', 'codex ⠙ working')).toBe('working');
    expect(activityFromTitle('codex', 'building ⠹')).toBe('working');
  });

  it('reads Action Required as waiting for a person', () => {
    // Codex publishes blocked in the title; Claude does not.
    expect(activityFromTitle('codex', 'Action Required')).toBe('blocked');
    expect(activityFromTitle('codex', 'codex — Action Required')).toBe('blocked');
  });

  it('prefers blocked over working when the title could be read as both', () => {
    // An agent waiting for a person may still be drawing a spinner. "Needs
    // you" outranks "busy".
    expect(activityFromTitle('codex', '⠙ Action Required')).toBe('blocked');
  });

  it('treats any other codex title as idle, because codex always sets one', () => {
    // Its idle is not a glyph: having a title that is neither the spinner nor
    // the blocked marker IS the statement.
    expect(activityFromTitle('codex', 'codex')).toBe('idle');
    expect(activityFromTitle('codex', '~/GitHub/agenfk')).toBe('idle');
  });

  it('does not apply that rule to an agent that does not always set a title', () => {
    // Claude only speaks with a glyph, so an unrecognised Claude title means
    // we do not know — not that it went to sleep.
    expect(activityFromTitle('claude-code', 'agenfk — main')).toBe('unknown');
  });

  it('covers only the agents that were actually checked', () => {
    // A drift guard in the other direction from the usual one: adding a rule
    // for an agent whose TUI nobody looked at would be a guess wearing the
    // costume of a fact.
    expect(Object.keys(TITLE_RULES).sort()).toEqual(['claude-code', 'codex']);
  });
});
