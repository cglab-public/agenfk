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

/**
 * A fake git that REFUSES what real git refuses.
 *
 * The first version of this returned '' for everything, and that is how nine
 * passing tests sat on top of a feature that had never once worked. The code
 * ran `rev-parse --verify -- <name>` and `checkout -- <name>`; `--` means
 * "everything after this is a PATHSPEC", so real git answers:
 *
 *   $ git rev-parse --verify -- main
 *   fatal: Needed a single revision
 *   $ git checkout -- feature
 *   error: pathspec 'feature' did not match any file(s) known to git
 *
 * A stub that says '' to both cannot tell a working implementation from a
 * broken one, and a test asserting the `--` was present actively locked the
 * defect in. So this models the one rule that matters: a revision argument
 * after `--` is not a revision.
 */
const spyGit = (impl?: (args: string[]) => string) => {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      const sep = args.indexOf('--');
      if (sep !== -1 && args[sep + 1] !== undefined) {
        if (args.includes('rev-parse')) throw new Error('fatal: Needed a single revision');
        if (args.includes('checkout')) {
          throw new Error(`error: pathspec '${args[sep + 1]}' did not match any file(s) known to git`);
        }
      }
      return impl?.(args) ?? '';
    },
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
  it('names the branch unambiguously without disarming the command', () => {
    /*
     * This test used to assert the OPPOSITE - that `--` preceded the name -
     * and it was wrong in the most expensive way available: it made the defect
     * permanent. `--` does not protect a revision argument, it reclassifies it
     * as a path, so the command could never resolve a branch at all.
     *
     * `refs/heads/<name>` is what actually removes the ambiguity, and it is
     * what worktrees.ts and server.ts have always used. A name like
     * `--upload-pack=x` cannot be read as an option once it is a path
     * component of a fully-qualified ref.
     */
    const git = onAnotherBranch();
    resolveBranchHint({ branchName: '--not-a-flag', worktreePath: '/wt/a' }, { run: git.run });
    const verify = git.calls.find(a => a.includes('rev-parse'))!;
    expect(verify).toContain('refs/heads/--not-a-flag');
    expect(verify, 'the pathspec separator is back and the command cannot resolve a branch')
      .not.toContain('--');
  });

  it('actually switches, against a git that refuses what real git refuses', () => {
    /*
     * The test whose absence let this ship. Everything else here asks what was
     * REQUESTED; this one asks whether the request works, against a stub that
     * rejects a revision handed in after `--` the way git does.
     */
    const git = onAnotherBranch();
    const hint = resolveBranchHint({ branchName: 'feat/x', worktreePath: '/wt/a' }, { run: git.run });
    expect(hint, 'the branch was reported missing when it exists').toMatch(/switched to branch/i);
    expect(git.calls.some(a => a.includes('checkout'))).toBe(true);
  });

  /*
   * A test called 'never builds a shell string' sat here and was vacuous.
   * `Array.isArray` is guaranteed by the `run: (args: string[]) => string`
   * signature, and its regex could only fire if the branch NAME contained
   * `&&` - which the fixture's name did not. It would have passed against an
   * implementation that built `sh -c "git checkout $name"`.
   *
   * Deleted rather than repaired. The property is real but it belongs to the
   * CALLER: index.ts is what chooses execFile over exec, and this module only
   * ever hands out an array because its own type says so. A test here could
   * only restate the type.
   */
});
