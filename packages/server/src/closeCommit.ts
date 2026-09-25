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

import { isWellFormedClaim, claimsCollide } from '@agenfk/core';

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
  /**
   * Files this card staged that fall OUTSIDE everything it claimed
   * (CGLAB-198).
   *
   * Reported here, never blocked HERE. The refusal is the validate route's
   * (aaa01834, a user decision after a card's unclaimed file was left staged
   * past DONE): it refuses the move that ends the flow while such a file is
   * claimed by nobody in the tree, and only notes it when a working card there
   * claims nothing and may own it. This module stays a pure commit.
   *
   * Empty when the card claimed nothing, which is most of them - a report on
   * every close is noise nobody reads.
   */
  readonly outsideClaims?: readonly string[];
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
  /**
   * The paths this card owns. When known, the commit is limited to them.
   *
   * Filtered through `isWellFormedClaim` on the way in: a pathspec is a command
   * argument, and a claim the claims module would reject must not reach git
   * just because it arrived through a different door.
   */
  claims?: readonly string[],
  /** A step commit (CGLAB-388) names its step instead of closing the card. */
  opts: { message?: string } = {},
): CloseCommitResult {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];
  const message = opts.message ?? `close(${card.type.toLowerCase()}): ${card.title} [${card.id}]`;
  const paths = (claims ?? []).filter(isWellFormedClaim);

  let staged: string;
  try {
    // `--name-only` rather than a status parse: the question is only whether
    // the index holds anything, and a filename with a newline in it cannot
    // turn a yes into a no.
    // --no-renames: otherwise a rename lists only its destination, and the
    // commit leaves the source's staged deletion behind (aaa01834 review).
    staged = deps.run(at('diff', '--cached', '--name-only', '--no-renames'));
  } catch (e: any) {
    return { committed: false, reason: `Could not read the index: ${gitSaid(e)}` };
  }

  /*
   * With a pathspec the question changes from "is anything staged" to "is any
   * of MINE staged". Committing without checking would produce an empty commit,
   * or succeed on a sibling's file and call it this card's work.
   */
  const stagedPaths = staged.split('\n').map(l => l.trim()).filter(Boolean);
  /*
   * `claimsCollide`, not a second implementation of it.
   *
   * The filter here used to be `f === p || f.startsWith(p.replace(/\/+$/,'') + '/')`,
   * and it DISAGREED with the gate on inputs the gate accepts: `src\a.ts`
   * against `src/a.ts`, `src//a.ts` against `src/a.ts`, `packages\ui` against
   * a file beneath it. A card told its claim was valid would then find that
   * none of its files matched. It also carried the quadratic trailing trim
   * that was removed from utils.ts and reintroduced twice since - measured at
   * 14 s for 200,000 separators, through input this module accepts.
   *
   * One question, asked in one place: does this staged file fall under a path
   * this card owns?
   */
  const mine = paths.length
    ? stagedPaths.filter(f => paths.some(p => claimsCollide(f, p)))
    : stagedPaths;

  /*
   * What was staged and is not ours.
   *
   * No guard on `paths.length`, and the absence is deliberate rather than an
   * oversight: with no claims `mine` IS everything staged, so the difference
   * is empty by construction. A `paths.length ?` in front of this reads like
   * it prevents a report on undeclared cards, and a mutation proved it
   * prevents nothing - it was decorative, and a decorative guard teaches the
   * next reader that something dangerous lives here.
   */
  const outsideClaims = stagedPaths.filter(f => !mine.includes(f));

  if (!mine.length) {
    return {
      committed: false,
      outsideClaims,
      reason: 'Nothing was staged, so nothing was committed. '
        + 'The server no longer stages files for you: several agents share this worktree, '
        + 'and `git add -A` would commit their work inside your card. '
        + 'Stage the files this card changed, then close it again.',
    };
  }

  /*
   * `git commit -- <pathspec>` COMMITS THE WORKING TREE, not the index.
   *
   * This module's whole premise is that it commits what you staged, and the
   * first version of the pathspec broke exactly that: adding a claim silently
   * turned the close into `git add -A -- <claims> && git commit`. Reproduced
   * by hand - index holding "reviewed", worktree holding "unreviewed", and the
   * commit took the worktree. It made the close LESS safe in the one dimension
   * this file exists for, and it is the 2026-09-14 incident narrowed to a
   * subtree rather than fixed.
   *
   * Git has no "commit the index, limited to these paths" in one command. What
   * it does have is an equivalence: when the worktree and the index agree on a
   * path, committing that path from either takes the same bytes. So the check
   * below establishes the equivalence, and REFUSES when it does not hold.
   *
   * Refusing is the right answer rather than a limitation. A claimed file that
   * differs between index and worktree means somebody edited this card's files
   * after it staged them - which is either the card being careless or another
   * agent inside its claim, and both are worth stopping for.
   */
  if (paths.length) {
    let drifted: string;
    try {
      drifted = deps.run(at('diff', '--name-only', '--', ...mine));
    } catch (e: any) {
      return { committed: false, reason: `Could not compare the index with the working tree: ${gitSaid(e)}` };
    }
    const changed = drifted.split('\n').map(l => l.trim()).filter(Boolean);
    if (changed.length) {
      return {
        committed: false,
        reason: 'These files were staged and then changed again, so committing them would take '
          + `the newer version rather than the one you staged: ${changed.join(', ')}. `
          + 'Stage them again if the change is yours. If it is not, another agent is editing '
          + 'inside this card\'s claim and that is worth finding out about before closing.',
      };
    }
  }

  try {
    /*
     * The pathspec is the STAGED FILES, never the claims themselves. A claim
     * may name a directory that does not exist yet - git answers `pathspec
     * 'docs' did not match any file(s) known to git` and exits non-zero, so a
     * card that claimed ahead of creating could never close. `mine` is by
     * construction a list of paths git just told us about.
     *
     * An argument array rather than a shell string: the title is user data and
     * reaches here unescaped.
     */
    const output = deps.run(at('commit', '-m', message, ...(paths.length ? ['--', ...mine] : [])));
    // `[branch (root-commit) abc1234] subject`: the abbreviated sha of THIS
    // commit. Expanded with rev-parse, which resolves it however HEAD moves.
    const short = /^\[[^\]]*?\b([0-9a-f]{7,40})\]/m.exec(output)?.[1];
    let sha: string | undefined;
    if (short) {
      try { sha = deps.run(at('rev-parse', '--verify', `${short}^{commit}`)).trim() || undefined; } catch { /* reported without a sha */ }
    }
    return { committed: true, output: output.trim(), outsideClaims, ...(sha ? { sha } : {}) };
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
