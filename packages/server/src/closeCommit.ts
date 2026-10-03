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
 * isolation: stage only your own files.
 *
 * Injectable runner, like gitStatus.ts and branchHint.ts, so the ARGUMENT LIST
 * is something a test can read back. Every git defect found in this server this
 * week was invisible until the arguments were observable.
 */

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
  /**
   * The commit this call made, read from git's own report of it, never from
   * HEAD afterwards: another agent in the same worktree may commit in between.
   */
  readonly sha?: string;
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
  /** A step commit (CGLAB-388) names its step instead of closing the card. */
  opts: { message?: string } = {},
): CloseCommitResult {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];
  const message = opts.message ?? `close(${card.type.toLowerCase()}): ${card.title} [${card.id}]`;

  let staged: string;
  try {
    // `--name-only` rather than a status parse: the question is only whether
    // the index holds anything, and a filename with a newline in it cannot
    // turn a yes into a no.
    staged = deps.run(at('diff', '--cached', '--name-only'));
  } catch (e: any) {
    return { committed: false, reason: `Could not read the index: ${gitSaid(e)}` };
  }

  const stagedPaths = staged.split('\n').map(l => l.trim()).filter(Boolean);

  if (!stagedPaths.length) {
    return {
      committed: false,
      reason: 'Nothing was staged, so nothing was committed. '
        + 'The server no longer stages files for you: several agents share this worktree, '
        + 'and `git add -A` would commit their work inside your card. '
        + 'Stage the files this card changed, then close it again.',
    };
  }

  try {
    // An argument array rather than a shell string: the title is user data and
    // reaches here unescaped. No pathspec: the commit takes the index.
    const output = deps.run(at('commit', '-m', message));
    // `[branch (root-commit) abc1234] subject`: the abbreviated sha of THIS
    // commit. Expanded with rev-parse, which resolves it however HEAD moves.
    const short = /^\[[^\]]*?\b([0-9a-f]{7,40})\]/m.exec(output)?.[1];
    let sha: string | undefined;
    if (short) {
      try { sha = deps.run(at('rev-parse', '--verify', `${short}^{commit}`)).trim() || undefined; } catch { /* reported without a sha */ }
    }
    return { committed: true, output: output.trim(), ...(sha ? { sha } : {}) };
  } catch (e: any) {
    return { committed: false, reason: gitSaid(e) };
  }
}

export interface CommitRootItem {
  readonly id: string;
  /** The item's own checkout, when it has one. */
  readonly worktreePath?: string | null;
}

export type CommitRoot =
  | { readonly root: string; readonly reason?: undefined }
  | { readonly root: null; readonly reason: string };

/**
 * WHICH DIRECTORY THE CLOSE COMMIT RUNS IN.
 *
 * A GIT WORKTREE HAS ITS OWN INDEX, and that is the whole of this. Verified by
 * hand rather than assumed: stage a file inside a linked worktree and
 * `git -C <worktree> diff --cached --name-only` lists it while
 * `git -C <primary> diff --cached --name-only` is EMPTY.
 *
 * The close commit was resolving `project.projectRoot` and never looking at the
 * item's worktree, so for every card that has one - which is every card under
 * `autoWorktree`, `agenfk branch create`, and the PR import - it read the wrong
 * index. The agent stages its files, verifies onto the final step, and is told
 * "Nothing was staged, so nothing was committed. Stage the files this card
 * changed, then close it again." It had. And in the worse direction: whatever
 * the HUMAN happened to have staged in the primary checkout gets committed
 * under the card's message.
 *
 * IT DECLINES RATHER THAN FALLING BACK TO THE PROCESS CWD. The old expression
 * ended in `|| findProjectRoot(process.cwd())`, and `findProjectRoot` returns
 * its start directory when it finds nothing - so a long-lived `agenfk up`
 * daemon would commit into whatever repository it happened to be launched
 * from. branchHint refuses the same fallback by name, and it is refused here
 * for the same reason: "no worktree, so use the process cwd" is the original
 * defect restated as a default.
 */
export function resolveCommitRoot(
  item: CommitRootItem,
  projectRoot: string | null | undefined,
): CommitRoot {
  const worktree = item.worktreePath?.trim();
  // The item's own checkout wins whenever it has one. Not a preference: the
  // other directory holds a different index.
  if (worktree) return { root: worktree };
  const root = projectRoot?.trim();
  if (root) return { root };
  return {
    root: null,
    reason: `Card ${item.id} has no worktree and its project has no projectRoot, so there is no `
      + 'directory this commit could safely run in. Nothing was committed. Set one with '
      + '`agenfk update-project <id> --project-root <path>`, or give the card a worktree with '
      + '`agenfk branch create <itemId>`.',
  };
}
