/**
 * Closing a card must not commit somebody else's work (c3d36f46).
 *
 * The close commit ran `git add -A && git commit` in the project root. It swept
 * the whole tree, and on 2026-09-14 it did so twice in one session: two other
 * agents' half-finished edits landed inside a card's commit, once including six
 * failing tests.
 *
 * That was survivable while sharing a tree was an accident. It is now the
 * design - several agents work one task in one worktree - so every close is a
 * sweep over two or three other agents' work, every time.
 *
 * SO IT COMMITS WHAT WAS STAGED, and nothing else. An agent knows which files
 * it touched; the server does not and has never had a way to find out. Staging
 * is the one signal that already carries that knowledge, and `add -A` is
 * precisely the instruction to discard it.
 *
 * With nothing staged it DECLINES rather than falling back. A fallback here is
 * the original defect wearing a condition.
 */
import { describe, it, expect, vi } from 'vitest';
import { commitStagedForCard, resolveCommitRoot } from '../closeCommit';

/** Records every git invocation, so the ARGUMENTS can be asserted. */
const spyGit = (staged: string[] = ['packages/ui/src/thing.ts']) => {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      // `diff --cached --name-only` is how the caller asks what is staged.
      if (args.includes('--cached')) return staged.join('\n');
      return '';
    },
  };
};

const card = { id: 'abc12345-0000', type: 'TASK', title: 'Wire the thing' };

describe('what reaches git', () => {
  it('never stages anything itself', () => {
    /*
     * THE test. `git add` in any form is the whole defect: the server cannot
     * know which files belong to the card, so any staging it does is a guess
     * over other agents' work.
     */
    const git = spyGit();
    commitStagedForCard(card, '/repo', { run: git.run });
    const staging = git.calls.filter(a => a.includes('add'));
    expect(staging, `the close commit staged files itself: ${JSON.stringify(staging)}`).toEqual([]);
  });

  it('commits without touching the working tree', () => {
    /*
     * The name was a false claim for as long as claims existed: `-a` is not
     * the only spelling of "take the working tree", and `git commit -- <paths>`
     * is the other one. That defect lived behind this green test until an
     * adversarial review reproduced it; the case that catches it needs a REAL
     * repository with the index and worktree differing, and lives in
     * worktree-api.test.ts. This one keeps the flag half honest.
     */
    const git = spyGit();
    commitStagedForCard(card, '/repo', { run: git.run });
    const commit = git.calls.find(a => a.includes('commit'))!;
    expect(commit).toBeDefined();
    expect(commit).not.toContain('-a');
    expect(commit).not.toContain('--all');
  });

  it('runs in the repository it was given, not in the process cwd', () => {
    // The same rule three other places in this server learned the hard way.
    const git = spyGit();
    commitStagedForCard(card, '/repo', { run: git.run });
    for (const call of git.calls) {
      expect(call.slice(0, 2), `a git call escaped the repo: ${call.join(' ')}`).toEqual(['-C', '/repo']);
    }
  });

  it('names the card in the message, as it always has', () => {
    const git = spyGit();
    commitStagedForCard(card, '/repo', { run: git.run });
    const commit = git.calls.find(a => a.includes('commit'))!;
    expect(commit.join(' ')).toMatch(/close\(task\): Wire the thing \[abc12345-0000\]/);
  });
});

describe('when nothing is staged', () => {
  it('declines instead of committing whatever is lying around', () => {
    /*
     * The tempting fallback - "nothing staged, so stage everything" - is the
     * original defect with a condition in front of it.
     */
    const git = spyGit([]);
    const result = commitStagedForCard(card, '/repo', { run: git.run });
    expect(result.committed).toBe(false);
    expect(git.calls.some(a => a.includes('commit'))).toBe(false);
  });

  it('says what to do about it, since this is new behaviour', () => {
    // An agent that has always been committed FOR will meet this once and
    // needs to know that staging is now its job.
    const git = spyGit([]);
    const result = commitStagedForCard(card, '/repo', { run: git.run });
    expect(result.reason).toMatch(/stage/i);
  });
});

describe('when git fails', () => {
  /**
   * Thrown the way execFileSync actually throws, which is the point.
   *
   * The first version of this test threw `new Error('nothing to commit,
   * working tree clean')` - a message shape real git never produces - and then
   * asserted on it. It verified the fake. Measured against real git:
   *
   *   e.message → "Command failed: git -C /tmp/xyz commit -m x"
   *   e.stderr  → ""
   *   e.stdout  → "On branch main\nnothing to commit, working tree clean\n"
   *
   * So reading `e.message` loses the diagnostic entirely, and the test that was
   * meant to catch that could not, because its fake put the explanation where
   * the code was already looking.
   */
  const gitThrowing = (stdout: string, stderr = '') => {
    const calls: string[][] = [];
    return {
      calls,
      run: (args: string[]) => {
        calls.push(args);
        if (args.includes('--cached')) return 'a.ts';
        throw Object.assign(new Error('Command failed: git -C /repo commit -m x'), { stdout, stderr });
      },
    };
  };

  it('reports what git said, not the command line', () => {
    const git = gitThrowing('On branch main\nnothing to commit, working tree clean\n');
    const result = commitStagedForCard(card, '/repo', { run: git.run });
    expect(result.committed).toBe(false);
    expect(result.reason, 'the diagnostic was replaced by the command line')
      .toMatch(/nothing to commit/i);
  });

  it('surfaces a hook rejection, which arrives on stderr', () => {
    // The failure worth surfacing most: a pre-commit hook refusing the work.
    // Silent here means an agent told only that "git failed".
    const git = gitThrowing('', 'pre-commit hook refused: lint errors');
    expect(commitStagedForCard(card, '/repo', { run: git.run }).reason)
      .toMatch(/pre-commit hook refused/i);
  });

  it('falls back to the command line when git said nothing at all', () => {
    const git = gitThrowing('', '');
    expect(commitStagedForCard(card, '/repo', { run: git.run }).reason)
      .toMatch(/command failed/i);
  });
});

/**
 * One index per WORKTREE, not per agent (review of d997368d).
 *
 * The commit that introduced this module said staging "is the signal that
 * already carries that knowledge" - which needs a per-agent index, and
 * `.git/index` is per-worktree. The design the same commit describes is several
 * agents in ONE worktree, so they share it.
 *
 * So `git commit` with no pathspec still takes whatever any of them staged:
 * agent B runs `git add b.ts`, agent A closes, and b.ts lands inside A's card.
 * Narrower than `add -A` and a real improvement, but the commit presented it as
 * solved and it was not.
 *
 * THE PATHSPEC IS WHAT MAKES IT TRUE. A card's claims are precisely the list of
 * paths it owns, so committing `-- <claims>` takes the card's files out of the
 * shared index and leaves everybody else's where they were. The claims module
 * exists; persisting them is the next card, and this is the half that has to be
 * ready when it lands.
 */
describe('a shared index (review of d997368d)', () => {
  it('limits the commit to the card\'s own paths when they are known', () => {
    const git = spyGit(['a.ts', 'b.ts']);
    commitStagedForCard(card, '/repo', { run: git.run }, ['a.ts']);
    const commit = git.calls.find(c => c.includes('commit'))!;
    expect(commit, 'the commit took the whole index in a shared worktree').toContain('--');
    expect(commit[commit.indexOf('--') + 1]).toBe('a.ts');
  });

  it('declines when none of the card\'s paths are staged', () => {
    /*
     * The other half. With a pathspec, "something is staged" is no longer the
     * question - "is any of MINE staged" is. Committing here would produce an
     * empty commit, or worse, silently succeed on a sibling's file.
     */
    const git = spyGit(['someone-elses.ts']);
    const result = commitStagedForCard(card, '/repo', { run: git.run }, ['a.ts']);
    expect(result.committed).toBe(false);
    expect(git.calls.some(c => c.includes('commit'))).toBe(false);
  });

  it('takes the whole index when the card claims nothing, as before', () => {
    // No claims yet is the state every card is in today. The behaviour has to
    // stay what it is until they exist, or this lands as a silent no-op.
    const git = spyGit(['a.ts']);
    const result = commitStagedForCard(card, '/repo', { run: git.run });
    expect(result.committed).toBe(true);
    const commit = git.calls.find(c => c.includes('commit'))!;
    expect(commit).not.toContain('--');
  });

  it('ignores a claim that is not well formed rather than passing it to git', () => {
    // A pathspec is a command argument. A claim the claims module would reject
    // must not reach git just because it arrived by a different door.
    const git = spyGit(['a.ts']);
    commitStagedForCard(card, '/repo', { run: git.run }, ['a.ts', '../../etc/passwd']);
    const commit = git.calls.find(c => c.includes('commit'))!;
    expect(commit.join(' ')).not.toContain('..');
  });
});

/**
 * Which directory the close commit runs in.
 *
 * A GIT WORKTREE HAS ITS OWN INDEX - verified by hand, not assumed: stage a
 * file inside a linked worktree and the primary checkout's
 * `diff --cached --name-only` comes back EMPTY. The close commit resolved
 * `project.projectRoot` and never looked at the item's worktree, so for every
 * card that has one it read the wrong index and told the agent "Nothing was
 * staged, so nothing was committed. Stage the files this card changed, then
 * close it again." It had.
 *
 * No test could see it: autoGitCommit is skipped under test by construction
 * (NODE_ENV/VITEST at every call site) and every test calls it with an explicit
 * root, so the CALLER's choice of directory was unobservable. That is why this
 * survived a branch that spent its length on exactly this defect class.
 */
describe('the directory the commit runs in', () => {
  it('uses the item\'s own worktree, not the project root', () => {
    /*
     * THE test. They are different checkouts with different indexes, so this
     * is not a preference between two spellings of the same place.
     */
    const r = resolveCommitRoot(
      { id: 'card-1', worktreePath: '/wt/feat-x' },
      '/repo/primary',
    );
    expect(r.root, 'it committed from the primary checkout').toBe('/wt/feat-x');
  });

  it('falls back to the project root only when there is no worktree', () => {
    expect(resolveCommitRoot({ id: 'card-1' }, '/repo/primary').root).toBe('/repo/primary');
    expect(resolveCommitRoot({ id: 'card-1', worktreePath: null }, '/repo/primary').root)
      .toBe('/repo/primary');
    // Whitespace is not a path. A blank worktreePath reaching git as a cwd is
    // an ENOENT whose message explains nothing.
    expect(resolveCommitRoot({ id: 'card-1', worktreePath: '   ' }, '/repo/primary').root)
      .toBe('/repo/primary');
  });

  it('DECLINES rather than falling back to wherever the process is standing', () => {
    /*
     * The old expression ended in `|| findProjectRoot(process.cwd())`, and
     * findProjectRoot returns its start directory when it finds nothing - so a
     * long-lived `agenfk up` daemon would commit into whatever repository it
     * was launched from, under a card's message. branchHint refuses this same
     * fallback by name: "no worktree, so use the process cwd" is the original
     * defect restated as a default.
     */
    for (const root of [undefined, null, '', '   ']) {
      const r = resolveCommitRoot({ id: 'card-1' }, root);
      expect(r.root, `it invented a directory for ${JSON.stringify(root)}`).toBeNull();
    }
  });

  it('says what to do about it, naming both ways out', () => {
    // A refusal that only states the problem is one people read twice and act
    // on never - and this one fires at the moment a card is being closed.
    const r = resolveCommitRoot({ id: 'card-1' }, null);
    expect(r.reason).toMatch(/--project-root/);
    expect(r.reason).toMatch(/branch create/);
    expect(r.reason, 'it did not say the commit was skipped').toMatch(/[Nn]othing was committed/);
  });
});
