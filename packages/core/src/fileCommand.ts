/**
 * A command that came from the repository.
 *
 * `.agenfk/project.json` may declare `verifyCommand`, which is what makes a
 * project's configuration travel. It runs like any other committed code: the
 * stored command already runs whatever the repository contains, so a
 * per-machine approval of the declared one protected little and could not be
 * given in the browser at all (#260). Who may change the command is the hub's
 * job from 2.1 (RFC-002).
 *
 * One rule stays: a command holding characters a screen cannot show
 * faithfully never runs, because what a person reads would not be what the
 * shell executes.
 */

export interface CommandFromFile {
  /** Which setting it is, for the sentence shown to the person. */
  readonly key: 'verifyCommand' | 'setupCommand';
  readonly command: string;
}

/**
 * Why this repository command cannot run, or null when it can: only when it
 * holds characters a screen cannot show faithfully.
 */
export function unreadableFileCommand(from: CommandFromFile | null): { reason: string; hidden: string[] } | null {
  if (!from || !from.command.trim()) return null;
  const hidden = hiddenCharacters(from.command);
  if (!hidden.length) return null;
  return {
    hidden,
    reason:
      `This project's ${from.key} comes from the repository's own file and holds characters that cannot be shown faithfully (${hidden.join(', ')}), `
      + 'so what a person reads is not what would run. Remove them from .agenfk/project.json.',
  };
}

/**
 * Characters in a command that a screen cannot show a person faithfully.
 *
 * Format controls (bidi overrides and isolates, zero-width marks, the BOM),
 * other control characters, line/paragraph separators, and every
 * Default_Ignorable_Code_Point - the combining grapheme joiner (U+034F) and the
 * variation selectors render as nothing, so `npm run test͏` reads as
 * `npm run test` and names another script. A right-to-left
 * override can make `echo 'safe<U+202E>'; payload; #` READ as one quoted echo
 * while the shell runs a second command; a zero-width space makes `./verify`
 * name a different file (review of 34ee6b8a). A verify command never needs
 * one, so a command holding any never runs. Tab and newline stay legal: they
 * are shown as what they are. A carriage return is not: it is not shown, and
 * the shell keeps it in the word before it.
 *
 * Returns each offending character as `U+XXXX`, in order, without repeats.
 */
export function hiddenCharacters(command: string): string[] {
  const found = new Set<string>();
  for (const ch of command) {
    // Tab and newline only. Not CR: `npm run test\r # note` shows as `npm run test` while the
    // shell names the script `test\r` - which the repository can supply (review of 34ee6b8a).
    if (ch === '\t' || ch === '\n') continue;
    if (/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(ch)) {
      found.add(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return [...found];
}
