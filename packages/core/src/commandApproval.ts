/**
 * Approving a command that came from the repository.
 *
 * `.agenfk/project.json` may declare `verifyCommand` and `setupCommand`, which
 * is what makes a project's configuration travel — and also what makes cloning
 * a repository a way to hand this machine a command it will run. The decision
 * taken for that: the file may declare them, and the FIRST time a given command
 * arrives from the file, the person sees it and says yes.
 *
 * Approval is per exact command, not per project: editing the command — or
 * pulling a change to it — asks again, because the thing that was read and
 * approved is the string, not the field it sits in.
 *
 * Approval is also per MACHINE. It says "I have read this and I am willing to
 * run it here", which is not a statement anybody can make on somebody else's
 * behalf, so it is stored beside the project rather than in the file.
 */
import { createHash } from 'node:crypto';

/**
 * A stable name for one exact command: SHA-256 of its trimmed text.
 *
 * CRYPTOGRAPHIC, because the approval depends on it. It used to be a 64-bit
 * FNV-style mix, documented as "not defending against a collision attack" on
 * the theory that an attacker who can edit the file must ask again. That
 * missed the chosen pair: an author writes two commands with one fingerprint,
 * gets the harmless one approved, then swaps in the other with a pull - and
 * it runs without anybody being asked. A pair was found in 0.04 s (review of
 * 34ee6b8a). Fingerprints stored under the old scheme no longer match, so
 * every repository command is asked about once more - the safe direction.
 */
export function commandFingerprint(command: string): string {
  return createHash('sha256').update(command.trim(), 'utf8').digest('hex');
}

export interface CommandFromFile {
  /** Which setting it is, for the sentence shown to the person. */
  readonly key: 'verifyCommand' | 'setupCommand';
  readonly command: string;
}

export interface ApprovalVerdict {
  readonly allowed: boolean;
  /** Present when it is not allowed: what to show, and what to approve. */
  readonly fingerprint?: string;
  readonly reason?: string;
}

/**
 * May this command run here?
 *
 * A command the project already had — set through the CLI on this machine —
 * needs no approval: nothing about it arrived from a repository. Only one that
 * came from the file does, and only until somebody has read it.
 */
export function approvalFor(
  from: CommandFromFile | null,
  approved: readonly string[] = [],
): ApprovalVerdict {
  if (!from || !from.command.trim()) return { allowed: true };
  const fingerprint = commandFingerprint(from.command);
  if (approved.includes(fingerprint)) return { allowed: true, fingerprint };
  return {
    allowed: false,
    fingerprint,
    reason:
      `This project's ${from.key} comes from the repository's own file, and has not been approved on this machine yet:\n\n`
      + `  ${from.command.trim()}\n\n`
      + 'Read it, then approve it on the board - the project\'s Settings, in `agenfk ui` - to let it run here. '
      + 'An agent cannot approve it: approving is the decision to run it, and that decision is a person\'s.',
  };
}

/**
 * Characters in a command that a screen cannot show a person faithfully.
 *
 * Format controls (bidi overrides and isolates, zero-width marks, the BOM),
 * other control characters, and line/paragraph separators. A right-to-left
 * override can make `echo 'safe<U+202E>'; payload; #` READ as one quoted echo
 * while the shell runs a second command; a zero-width space makes `./verify`
 * name a different file (review of 34ee6b8a). A verify command never needs
 * one, so a command holding any is not offered for approval at all. Tab and
 * newline stay legal: they are shown as what they are.
 *
 * Returns each offending character as `U+XXXX`, in order, without repeats.
 */
export function hiddenCharacters(command: string): string[] {
  const found = new Set<string>();
  for (const ch of command) {
    if (ch === '\t' || ch === '\n' || ch === '\r') continue;
    if (/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u.test(ch)) {
      found.add(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return [...found];
}
