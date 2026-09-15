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
 * Injectable runner, like gitStatus.ts and branchHint.ts, so the ARGUMENT LIST
 * is something a test can read back. Every git defect found in this server this
 * week was invisible until the arguments were observable.
 */

export interface CloseCommitDeps {
  /** Run git with these arguments and return stdout. Throws if git fails. */
  readonly run: (args: string[]) => string;
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
): CloseCommitResult {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];
  const message = `close(${card.type.toLowerCase()}): ${card.title} [${card.id}]`;

  let staged: string;
  try {
    // `--name-only` rather than a status parse: the question is only whether
    // the index holds anything, and a filename with a newline in it cannot
    // turn a yes into a no.
    staged = deps.run(at('diff', '--cached', '--name-only'));
  } catch (e: any) {
    return { committed: false, reason: `Could not read the index: ${e?.message ?? 'git failed'}` };
  }

  if (!staged.trim()) {
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
    const output = deps.run(at('commit', '-m', message));
    return { committed: true, output: output.trim() };
  } catch (e: any) {
    return { committed: false, reason: e?.message?.trim() ?? 'git commit failed' };
  }
}
