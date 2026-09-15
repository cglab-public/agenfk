/**
 * Putting the gatekeeper on the item's branch, in the item's OWN tree (58a4f90e).
 *
 * The gatekeeper offered to switch you onto the card's branch, and ran three
 * git commands to do it - `rev-parse --verify`, `rev-parse --abbrev-ref HEAD`
 * and `checkout` - with no `cwd` and no `-C`. So it read the branch of one
 * repository and changed the branch of another: whichever one the server
 * process happened to be started in.
 *
 * The same defect was fixed a few hundred lines away for `git status`, and the
 * comment left there is the rule this file enforces: never the server's own
 * cwd, because that reports "the state of whatever repository the server
 * happens to be running in - confidently, and about the wrong tree".
 *
 * IT IS WORSE HERE THAN THERE. Reading the wrong tree is a wrong answer;
 * checking out in the wrong tree is a WRITE, it is silent (`stdio: 'ignore'`),
 * and the process doing it is not the one that will notice. With several
 * agents running at once it stops being wrong and becomes destructive.
 *
 * So the first two tests are about the `-C`, and the third is the one that
 * matters most: with no worktree recorded, it must run NOTHING rather than
 * falling back to the process cwd.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveBranchHint } from '../branchHint';

/** Records every git invocation, so the cwd can be asserted per call. */
const spyGit = (impl?: (args: string[]) => string) => {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => { calls.push(args); return impl?.(args) ?? ''; },
  };
};

/** A tree whose HEAD is on some other branch, so a switch is called for. */
const onAnotherBranch = () => spyGit(args =>
  args.includes('--abbrev-ref') ? 'main' : '');

describe('which tree the commands run in', () => {
  it('checks out inside the item\'s worktree, never wherever the server is', () => {
    /*
     * THE test. `-C <dir>` on the checkout itself: a `cwd` on the other two
     * and not on this one would still leave the write landing in the wrong
     * place, which is the only call here that changes anything.
     */
    const git = onAnotherBranch();
    resolveBranchHint({ branchName: 'feat/x', worktreePath: '/wt/item-1' }, { run: git.run });
    const checkout = git.calls.find(a => a.includes('checkout'));
    expect(checkout, 'no checkout was attempted at all').toBeDefined();
    expect(checkout!.slice(0, 2)).toEqual(['-C', '/wt/item-1']);
  });

  it('reads the current branch from that tree too', () => {
    // Reading HEAD elsewhere is how it decided a switch was needed. Get that
    // wrong and it switches a tree that was already on the right branch, or
    // skips one that was not.
    const git = onAnotherBranch();
    resolveBranchHint({ branchName: 'feat/x', worktreePath: '/wt/item-1' }, { run: git.run });
    for (const call of git.calls) {
      expect(call.slice(0, 2), `a git call escaped the worktree: ${call.join(' ')}`)
        .toEqual(['-C', '/wt/item-1']);
    }
  });

  it('runs NOTHING when the item has no worktree on disk', () => {
    /*
     * The most important one. The tempting fallback is "no worktree, so use
     * the process cwd" - which is exactly the defect, restated as a default.
     * An item with no tree is a case to decline, not to guess at.
     */
    const git = spyGit();
    const hint = resolveBranchHint({ branchName: 'feat/x' }, { run: git.run });
    expect(git.calls, 'git was run without a worktree to run it in').toEqual([]);
    expect(hint).toMatch(/worktree/i);
  });
});

describe('what it tells the agent', () => {
  it('says it switched, when it did', () => {
    const git = onAnotherBranch();
    const hint = resolveBranchHint({ branchName: 'feat/x', worktreePath: '/wt/a' }, { run: git.run });
    expect(hint).toMatch(/switched to branch 'feat\/x'/i);
  });

  it('says it was already there, and switches nothing', () => {
    // Checking out a branch you are already on is not harmless: it is a write
    // against a tree somebody may be editing.
    const git = spyGit(args => (args.includes('--abbrev-ref') ? 'feat/x' : ''));
    const hint = resolveBranchHint({ branchName: 'feat/x', worktreePath: '/wt/a' }, { run: git.run });
    expect(git.calls.some(a => a.includes('checkout'))).toBe(false);
    expect(hint).toMatch(/already on branch/i);
  });

  it('says the branch is missing rather than pretending it switched', () => {
    const git = spyGit(args => {
      if (args.includes('--verify')) throw new Error('unknown revision');
      return '';
    });
    const hint = resolveBranchHint({ branchName: 'feat/gone', worktreePath: '/wt/a' }, { run: git.run });
    expect(hint).toMatch(/does not exist/i);
    expect(git.calls.some(a => a.includes('checkout'))).toBe(false);
  });

  it('says nothing at all for an item with no branch', () => {
    const git = spyGit();
    expect(resolveBranchHint({}, { run: git.run })).toBe('');
    expect(git.calls).toEqual([]);
  });
});

describe('the branch name is data, not a command', () => {
  it('passes it as an argument and stops option parsing', () => {
    /*
     * Kept from the original, which got this right and said why: branchName is
     * stored data, this runs implicitly on every gatekeeper call, and a name
     * like `--upload-pack=...` must not be read as an option. The `--` is what
     * stops that, and it has to survive the move into this module.
     */
    const git = onAnotherBranch();
    resolveBranchHint({ branchName: '--not-a-flag', worktreePath: '/wt/a' }, { run: git.run });
    const checkout = git.calls.find(a => a.includes('checkout'))!;
    expect(checkout[checkout.indexOf('checkout') + 1]).toBe('--');
  });

  it('never builds a shell string', () => {
    // The caller takes an ARRAY. A template literal here would make
    // `main; rm -rf ~` a stored value that runs.
    const git = onAnotherBranch();
    resolveBranchHint({ branchName: 'a b; echo hi', worktreePath: '/wt/a' }, { run: git.run });
    for (const call of git.calls) {
      expect(Array.isArray(call)).toBe(true);
      expect(call.join(' ')).not.toMatch(/&&|\|\|/);
    }
  });
});
