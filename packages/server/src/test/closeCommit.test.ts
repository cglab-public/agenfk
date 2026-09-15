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
import { commitStagedForCard } from '../closeCommit';

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
    // No `-a` either, which is `add -A` by another spelling for tracked files.
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
  it('reports it rather than claiming a commit', () => {
    const git = {
      calls: [] as string[][],
      run: (args: string[]) => {
        git.calls.push(args);
        if (args.includes('--cached')) return 'a.ts';
        throw new Error('nothing to commit, working tree clean');
      },
    };
    const result = commitStagedForCard(card, '/repo', { run: git.run });
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/nothing to commit/i);
  });
});
