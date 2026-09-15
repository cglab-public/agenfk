/**
 * Putting the gatekeeper on the item's branch, in the item's OWN tree (58a4f90e).
 *
 * This was inline in the MCP gatekeeper and ran three git commands with no
 * `cwd` and no `-C`: `rev-parse --verify`, `rev-parse --abbrev-ref HEAD` and
 * `checkout`. So it read the branch of one repository and changed the branch of
 * another - whichever the server process was started in.
 *
 * The rule it broke is written a few hundred lines from where it lived, on the
 * git-status route that had the same defect first: never the server's own cwd,
 * because that answers about "whatever repository the server happens to be
 * running in - confidently, and about the wrong tree".
 *
 * WORSE HERE THAN THERE. Reading the wrong tree gives a wrong answer; checking
 * out in the wrong tree is a WRITE, it was silent, and the process doing it is
 * not the one that would notice. With several agents running at once that is
 * destructive rather than merely incorrect.
 *
 * Extracted rather than patched in place so the cwd can actually be asserted.
 * Same shape as gitStatus.ts and the desktop's processTree.ts: the caller
 * injects the runner, and the test reads back what was asked for.
 */

export interface BranchHintDeps {
  /** Run git with these arguments and return stdout. Throws if git fails. */
  readonly run: (args: string[]) => string;
}

export interface BranchHintItem {
  readonly branchName?: string;
  /**
   * Where the item's checkout lives.
   *
   * Absent for an item that has no tree yet, and that case DECLINES rather
   * than falling back. "No worktree, so use the process cwd" is the original
   * defect restated as a default.
   */
  readonly worktreePath?: string;
}

/**
 * Switch the item's tree onto its branch, and say what happened.
 *
 * Returns the line the gatekeeper appends to its answer. Never throws: a
 * gatekeeper call that cannot sort the branch out still has to authorise or
 * refuse the edit, and losing that answer over a branch hint would be a much
 * larger failure than the hint itself.
 */
export function resolveBranchHint(item: BranchHintItem, deps: BranchHintDeps): string {
  if (!item.branchName) return '';

  if (!item.worktreePath) {
    return `\n⚠️ This item has no worktree on disk, so its branch was left alone.`
      + ` Create one with \`agenfk branch create <itemId>\`, or work on the current branch.`;
  }

  // Every call carries `-C`, including the two reads: deciding whether to
  // switch by looking at a different tree is how it would switch one that was
  // already correct, or skip one that was not.
  const at = (...args: string[]): string[] => ['-C', item.worktreePath!, ...args];

  try {
    /*
     * `--` before the name, and an argument ARRAY rather than a shell string.
     * branchName is stored data and this runs implicitly on every gatekeeper
     * call, so a name like `--upload-pack=…` must not be read as an option and
     * `main; rm -rf ~` must not be read at all. Both were right in the original
     * and both have to survive the move.
     */
    deps.run(at('rev-parse', '--verify', '--', item.branchName));
  } catch {
    return `\n⚠️ Branch '${item.branchName}' does not exist in this item's worktree.`
      + ` Work on the current branch or ask the user to create it.`;
  }

  try {
    const current = deps.run(at('rev-parse', '--abbrev-ref', 'HEAD')).trim();
    if (current === item.branchName) return `\n🔀 Already on branch '${item.branchName}'.`;
    deps.run(at('checkout', '--', item.branchName));
    return `\n🔀 Switched to branch '${item.branchName}'.`;
  } catch {
    // A checkout can fail for ordinary reasons - uncommitted changes that
    // would be overwritten, most of them. Saying so beats claiming a switch
    // that did not happen.
    return `\n⚠️ Could not switch to '${item.branchName}' in this item's worktree.`
      + ` It may have uncommitted changes in the way.`;
  }
}
