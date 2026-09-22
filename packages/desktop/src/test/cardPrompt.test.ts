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
