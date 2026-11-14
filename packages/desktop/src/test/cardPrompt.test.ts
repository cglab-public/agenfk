/**
 * @vitest-environment node
 *
 * The card's own words, as keystrokes.
 *
 * Everything pinned here follows from one fact: this is typed into a TUI. The
 * program on the other end decides what a key means, and Enter means "send" in
 * every agent here — so a description with newlines in it is not a longer
 * prompt, it is several prompts, the first of which starts work on half a
 * sentence.
 */
import { describe, it, expect } from 'vitest';
import { cardPrompt, MAX_PROMPT_CHARS } from '../main/cardPrompt';

const card = {
  id: 'a3736c19',
  type: 'TASK',
  title: 'Port the admin API',
  description: 'Move services private, keep the public gateway.',
  status: 'TODO',
};

describe('the prompt a card becomes', () => {
  it('leads with the id, which every workflow command afterwards needs', () => {
    expect(cardPrompt(card)).toContain('AgEnFK task a3736c19');
  });

  it('carries the title and the description', () => {
    const line = cardPrompt(card)!;
    expect(line).toContain('Port the admin API');
    expect(line).toContain('keep the public gateway');
  });

  it('says where the card is in its flow', () => {
    expect(cardPrompt(card)).toContain('It is in TODO');
  });

  it('is ONE line, whatever the description looked like', () => {
    // The whole reason this module exists: three paragraphs would arrive as
    // three prompts, and the first would start work on a fragment.
    const line = cardPrompt({ ...card, description: 'first\nsecond\r\nthird' })!;
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('first second third');
  });

  it('strips the 8-bit C1 introducers too, not only ESC', () => {
    // U+009B is the same escape introducer as ESC-[, in its one-character
    // form, and terminals parse it. The first version of this test probed
    // ESC alone — which is exactly why the hole existed.
    const line = cardPrompt({ ...card, description: '\u009b2Jwiped \u009dtitle\u0007 here' })!;
    expect(line).not.toMatch(/[\u0080-\u009f]/);
    expect(line).toContain('wiped');
  });

  it('removes bidi overrides and zero-width characters', () => {
    // They print as nothing and reverse or hide what follows, so a card can
    // show the agent one sentence and a reader another.
    const line = cardPrompt({ ...card, description: 'safe\u202e evil\u200b hidden' })!;
    expect(line).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
  });

  it('truncates on a code point, never inside a surrogate pair', () => {
    // Iterating a string yields WHOLE code points, so a surviving surrogate
    // can only be a lone one. (A regex over UTF-16 units cannot say this: the
    // low half of a valid pair matches any surrogate class.)
    const line = cardPrompt({ ...card, description: '\u{1f600}'.repeat(2000) })!;
    const lone = [...line].filter(ch => {
      const c = ch.codePointAt(0)!;
      return c >= 0xd800 && c <= 0xdfff;
    });
    expect(lone).toEqual([]);
  });

  it('strips the escape that starts an ANSI sequence', () => {
    // A description is text a person typed or an agent wrote. This is the one
    // place it stops being content and becomes input to a terminal.
    const line = cardPrompt({ ...card, description: '\u001b[31mred\u001b[0m here' })!;
    expect(line).not.toContain('\u001b');
    expect(line).toContain('red');
  });

  it('truncates a long one and says that it did', () => {
    const line = cardPrompt({ ...card, description: 'x'.repeat(5000) })!;
    expect(line.length).toBeLessThan(MAX_PROMPT_CHARS + 60);
    expect(line).toContain('truncated');
  });

  it('answers null when the card says nothing at all', () => {
    expect(cardPrompt({ id: 'x' })).toBeNull();
    expect(cardPrompt({ id: 'x', title: '   ', description: '\n' })).toBeNull();
  });

  it('works from a title alone, which is what a hand-written card has', () => {
    expect(cardPrompt({ id: 'x', title: 'Fix the picker' })).toContain('Fix the picker');
  });
});
