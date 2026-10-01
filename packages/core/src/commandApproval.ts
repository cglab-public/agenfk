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

/**
 * A short, stable name for one exact command.
 *
 * Deliberately not a cryptographic hash: this is not defending against a
 * collision attack — an attacker who can edit the file can simply write a
 * different command and ask for approval again. It exists so that "the command
 * changed" is detectable, and so the stored list is readable by a person.
 */
export function commandFingerprint(command: string): string {
  const text = command.trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
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
