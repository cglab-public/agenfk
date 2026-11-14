/**
 * What an agent is told when a terminal is opened on a card.
 *
 * The terminal used to open and WAIT. Pressing Start put an agent in the right
 * directory and then asked the person to retype what the card already says —
 * so the card's own words are what starts the work.
 *
 * THIS IS TYPED INTO A TUI, which is what shapes every rule below. It is not a
 * file, not an argv and not a message on a wire: it is keystrokes arriving at
 * an interactive program that decides on its own what a key means.
 */

export interface CardForPrompt {
  readonly id: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly type?: string | null;
  readonly status?: string | null;
}

/**
 * How much of a description is worth typing.
 *
 * A long one is not more instruction, it is a slower paste into a program that
 * redraws on every chunk — and the agent can read the card itself once it is
 * working. Truncation is marked so nobody mistakes the tail for the end.
 */
export const MAX_PROMPT_CHARS = 1500;

/**
 * ONE LINE, always.
 *
 * Newlines are the submit key in every agent TUI here, so a three-paragraph
 * description would arrive as three separate prompts — the first one starting
 * work on a fragment of a sentence. Control characters go for a related
 * reason: the ESC that begins an ANSI sequence is not text, and the
 * description is the one value on this path that somebody else wrote.
 */
function oneLine(text: string): string {
  return text
    // C0 and DEL, and C1 TOO: U+009B is the 8-bit form of the same escape
    // introducer as ESC-[, and terminals parse it. Stripping only the 7-bit
    // form enforced half the rule this function states.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    // Bidi overrides and zero-width characters: they print as nothing and
    // reverse or hide what follows, so a description can show the agent one
    // sentence and a reader another. Not a control character, same problem.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The prompt for this card, or null when there is nothing to say.
 *
 * Null rather than a bare "work on this card": a card with no title and no
 * description gives an agent nothing to act on, and a keystroke that means
 * nothing is worse than leaving the prompt to the person — the agent answers
 * anyway, and now there is a run to read.
 */
export function cardPrompt(card: CardForPrompt): string | null {
  const title = oneLine(String(card.title ?? ''));
  const description = oneLine(String(card.description ?? ''));
  if (!title && !description) return null;

  const kind = oneLine(String(card.type ?? 'card')).toLowerCase() || 'card';
  /*
   * THE ID COMES FIRST, right after the verb: every workflow command the agent
   * must run afterwards takes it — the gatekeeper, the verify, the comment. An
   * agent told to "port the admin API" with no id has to go looking for which
   * card that is, and picking the wrong one is worse than asking.
   */
  // The id through the same filter as everything else: the one-line promise
  // should hold here rather than depend on the server only ever minting uuids.
  const head = `Work on AgEnFK ${kind} ${oneLine(String(card.id))}${title ? `: ${title}` : ''}`;
  const status = oneLine(String(card.status ?? ''));
  const parts = [head];
  if (description) parts.push(description);
  if (status) parts.push(`It is in ${status}; follow the project's flow from there.`);

  const line = parts.join(' — ');
  if (line.length <= MAX_PROMPT_CHARS) return line;
  // By CODE POINT, not by UTF-16 unit: cutting between a surrogate pair leaves
  // a lone surrogate in argv, which becomes U+FFFD somewhere downstream.
  const cut = [...line].slice(0, MAX_PROMPT_CHARS).join('');
  return `${cut}… (truncated; read the card for the rest)`;
}
