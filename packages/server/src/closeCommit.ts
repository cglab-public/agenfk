/**
 * Committing a card's work without committing everyone else's (c3d36f46).
 *
 * The close commit was `git add -A && git commit` in the project root. It swept
 * the whole tree, and twice in one session it carried two other agents'
 * half-finished edits into a card's commit - once including six failing tests.
 *
 * That was survivable while sharing a checkout was an accident between
 * sessions. It is now the design: several agents work one task in one worktree,
 * so every close is a sweep over two or three other agents' work, every time.
 *
 * SO IT COMMITS WHAT IS STAGED. The server cannot know which files belong to a
 * card - it has never had a way to find out, which is exactly why `add -A` was
 * written in the first place. The agent does know. Staging is the signal that
 * already carries that knowledge, and `add -A` is the instruction to throw it
 * away.
 *
 * WITH NOTHING STAGED IT DECLINES. "Nothing staged, so stage everything" is the
 * original defect with a condition in front of it, and it would fire precisely
 * when an agent had been careful.
 *
 * THE INDEX IS PER WORKTREE, NOT PER AGENT, and an earlier version of this
 * docblock glossed over it. `.git/index` belongs to the tree, and the design
 * this module exists for is several agents sharing one - so a bare `git commit`
 * still takes whatever any of them staged. Narrower than `add -A`, and not
 * isolation.
 *
 * The card's CLAIMS are what close that gap: they are exactly the paths it
 * owns, so committing `-- <claims>` lifts the card's files out of the shared
 * index and leaves everybody else's untouched. Optional for now, because claims
 * are not persisted yet; without them the behaviour is what it was, which is
 * what keeps this from landing as a silent change.
 *
 * Injectable runner, like gitStatus.ts and branchHint.ts, so the ARGUMENT LIST
 * is something a test can read back. Every git defect found in this server this
 * week was invisible until the arguments were observable.
 */

import { isWellFormedClaim } from '@agenfk/core';

export interface CloseCommitDeps {
  /** Run git with these arguments and return stdout. Throws if git fails. */
  readonly run: (args: string[]) => string;
}

/**
 * What git actually said, out of whatever execFileSync threw.
 *
 * `e.message` is the COMMAND LINE and nothing else - "Command failed: git -C
 * /path commit -m ...". git puts the explanation on stdout, and sometimes on
 * stderr. The first version of this module used `e.message`, which turned every
 * real failure into an unhelpful echo: a rejected pre-commit hook, `gpg failed
 * to sign the data`, `Please tell me who you are` and the unmerged-paths
 * refusal all arrived as the same sentence. The code this replaced read
 * `stderr || stdout` and did surface them.
 *
 * The command line is the last resort rather than the first, and it is also
 * where the card's TITLE ends up, having been interpolated into the message.
 */
function gitSaid(e: any): string {
  const out = [e?.stderr, e?.stdout]
    .map(v => (typeof v === 'string' ? v : v?.toString?.() ?? ''))
    .map(v => v.trim())
    .filter(Boolean);
  if (out.length) return out.join('\n');
  return e?.message?.trim() ?? 'git failed';
}

export interface CloseCommitCard {
  readonly id: string;
  readonly type: string;
  readonly title: string;
}

export interface CloseCommitResult {
  readonly committed: boolean;
  /** Why not, when it did not. Surfaced to the agent, not only logged. */
  readonly reason?: string;
  readonly output?: string;
}

/**
 * Commit the staged changes as this card's close.
 *
 * Never throws: a card reaching its final step is a workflow fact, and failing
 * to record a commit must not undo it. The caller decides what to tell the
 * agent.
 */
export function commitStagedForCard(
  card: CloseCommitCard,
  repoRoot: string,
  deps: CloseCommitDeps,
  /**
   * The paths this card owns. When known, the commit is limited to them.
   *
   * Filtered through `isWellFormedClaim` on the way in: a pathspec is a command
   * argument, and a claim the claims module would reject must not reach git
   * just because it arrived through a different door.
   */
  claims?: readonly string[],
): CloseCommitResult {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];
  const message = `close(${card.type.toLowerCase()}): ${card.title} [${card.id}]`;
  const paths = (claims ?? []).filter(isWellFormedClaim);

  let staged: string;
  try {
    // `--name-only` rather than a status parse: the question is only whether
    // the index holds anything, and a filename with a newline in it cannot
    // turn a yes into a no.
    staged = deps.run(at('diff', '--cached', '--name-only'));
  } catch (e: any) {
    return { committed: false, reason: `Could not read the index: ${gitSaid(e)}` };
  }

  /*
   * With a pathspec the question changes from "is anything staged" to "is any
   * of MINE staged". Committing without checking would produce an empty commit,
   * or succeed on a sibling's file and call it this card's work.
   */
  const stagedPaths = staged.split('\n').map(l => l.trim()).filter(Boolean);
  const mine = paths.length
    ? stagedPaths.filter(f => paths.some(p => f === p || f.startsWith(p.replace(/\/+$/, '') + '/')))
    : stagedPaths;

  if (!mine.length) {
    return {
      committed: false,
      reason: 'Nothing was staged, so nothing was committed. '
        + 'The server no longer stages files for you: several agents share this worktree, '
        + 'and `git add -A` would commit their work inside your card. '
        + 'Stage the files this card changed, then close it again.',
    };
  }

  try {
    /*
     * No `-a`, which is `add -A` by another spelling for tracked files, and no
     * pathspec - the index is already the answer to "which files". An argument
     * array rather than a shell string: the title is user data and reaches here
     * unescaped.
     */
    const output = deps.run(at('commit', '-m', message, ...(paths.length ? ['--', ...paths] : [])));
    return { committed: true, output: output.trim() };
  } catch (e: any) {
    return { committed: false, reason: gitSaid(e) };
  }
}
