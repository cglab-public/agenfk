/**
 * The base moved underneath the agent (CGLAB-197).
 *
 * An agent starting against a base that has moved works against a world that
 * no longer exists and finds out at the merge, which is the most expensive
 * moment available.
 *
 * THE TEST THAT MATTERS IS THAT THE TWO HALVES STAY SEPARATE. The warning goes
 * out whenever the branch is behind at all; the threshold only decides whether
 * the dispatch WAITS. Tying them together produces the worst design available -
 * blocking below the threshold in silence, and saying nothing until acting on
 * it has stopped being cheap.
 */
import { describe, it, expect } from 'vitest';
import { measureBaseDrift, DISPATCH_STALE_THRESHOLD, resolveBaseBranch, driftTargets, dispatchDriftNotice } from '../baseDrift';

/** Records every git invocation, so the ARGUMENTS can be asserted. */
const spyGit = (behind: number, subjects: string[] = []) => {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      if (args.includes('rev-list')) return `${behind}\n`;
      if (args.includes('log')) return subjects.join('\n');
      return '';
    },
  };
};

const measure = (behind: number, subjects: string[] = [], threshold?: number) =>
  measureBaseDrift('feature/x', 'main', '/repo', spyGit(behind, subjects), threshold);

describe('the warning, which does not wait for the threshold', () => {
  it('warns on a single commit of drift', () => {
    /*
     * THE test. Most drift is harmless and worth a glance, not a stop - and a
     * warning that only appears at twenty commits arrives after the cheap
     * moment has passed.
     */
    const d = measure(1, ['tidy the readme']);
    expect(d.notice, 'silent about drift that is still cheap to act on').not.toBeNull();
    expect(d.shouldWait, 'one commit of drift stopped a dispatch').toBe(false);
  });

  it('says what landed, not only how many', () => {
    // "20 commits behind" tells an agent nothing it can act on. "the file you
    // are about to edit was rewritten" does.
    const d = measure(2, ['rewrite the parser', 'bump deps']);
    expect(d.notice).toContain('rewrite the parser');
    expect(d.landed).toEqual(['rewrite the parser', 'bump deps']);
  });

  it('tells the agent what to do with it', () => {
    expect(measure(3, ['x']).notice).toMatch(/pull it in first/i);
  });

  it('says nothing at all when the branch is current', () => {
    // A notice on every dispatch is noise, and noise is how the one that
    // matters gets skipped.
    const d = measure(0);
    expect(d.notice).toBeNull();
    expect(d.behind).toBe(0);
  });
});

describe('the threshold, which only decides whether it waits', () => {
  it('waits past the threshold', () => {
    const d = measure(DISPATCH_STALE_THRESHOLD + 1, ['a']);
    expect(d.shouldWait).toBe(true);
  });

  it('does not wait AT the threshold, so the edge is not a coin flip', () => {
    expect(measure(DISPATCH_STALE_THRESHOLD, ['a']).shouldWait).toBe(false);
  });

  it('says the card stays ready, because this is not a refusal', () => {
    /*
     * A SKIP, not a rejection: the card is picked up again next round. An
     * agent told "refused" goes looking for what it did wrong; one told "not
     * yet" rebases.
     */
    const d = measure(DISPATCH_STALE_THRESHOLD + 5, ['a']);
    expect(d.notice).toMatch(/stays ready|picked up again/i);
  });

  it('honours a threshold set deliberately', () => {
    expect(measure(5, ['a'], 3).shouldWait).toBe(true);
    expect(measure(5, ['a'], 50).shouldWait).toBe(false);
  });

  it('still warns below a raised threshold', () => {
    // The two halves stay independent however the threshold is set.
    const d = measure(30, ['a'], 100);
    expect(d.shouldWait).toBe(false);
    expect(d.notice).not.toBeNull();
  });
});

describe('what reaches git', () => {
  it('counts the base against the branch, in that direction', () => {
    /*
     * `branch..base` is what BASE has and the branch does not. Reversed, the
     * number is meaningless and plausible at the same time, which is the worst
     * kind of wrong - it would report a branch that is AHEAD as behind.
     */
    const git = spyGit(3);
    measureBaseDrift('feature/x', 'main', '/repo', git);
    const revList = git.calls.find(c => c.includes('rev-list'))!;
    expect(revList).toContain('feature/x..main');
  });

  it('runs in the repository it was given, not the process cwd', () => {
    // The same rule four other places in this server learned the hard way.
    const git = spyGit(3, ['a']);
    measureBaseDrift('feature/x', 'main', '/repo', git);
    for (const call of git.calls) {
      expect(call.slice(0, 2), `a git call escaped the repo: ${call.join(' ')}`).toEqual(['-C', '/repo']);
    }
  });

  it('bounds the subject list, so a year of drift is not pasted into a prompt', () => {
    const git = spyGit(400, ['a']);
    measureBaseDrift('feature/x', 'main', '/repo', git);
    expect(git.calls.find(c => c.includes('log'))!.join(' ')).toMatch(/--max-count=10/);
  });
});

describe('when git cannot answer', () => {
  it('reports current rather than inventing a blockage', () => {
    /*
     * A card being dispatched is a workflow fact, and failing to MEASURE drift
     * must not stop it. The generous reading is the only one that cannot
     * manufacture a stop out of a broken repository.
     */
    const throwing = { run: () => { throw new Error('not a git repository'); } };
    const d = measureBaseDrift('feature/x', 'main', '/repo', throwing);
    expect(d.behind).toBe(0);
    expect(d.shouldWait).toBe(false);
    expect(d.notice).toBeNull();
  });

  it('still warns when only the subject list fails', () => {
    // The count is the load-bearing half. Losing the subjects costs detail,
    // not the warning.
    const partial = {
      run: (args: string[]) => {
        if (args.includes('rev-list')) return '4\n';
        throw new Error('log failed');
      },
    };
    const d = measureBaseDrift('feature/x', 'main', '/repo', partial);
    expect(d.behind).toBe(4);
    expect(d.notice).not.toBeNull();
    expect(d.landed).toEqual([]);
  });

  it('treats unparseable output as current', () => {
    const weird = { run: () => 'not a number' };
    expect(measureBaseDrift('feature/x', 'main', '/repo', weird).behind).toBe(0);
  });
});

describe('where the drift is measured from', () => {
  it('prefers origin/HEAD when it resolves', () => {
    const git = { run: (args: string[]) => (args.includes('symbolic-ref') ? 'origin/main\n' : '') };
    expect(resolveBaseBranch('/repo', git)).toBe('origin/main');
  });

  it('ignores a dangling origin/HEAD and falls through to the local default', () => {
    /*
     * `symbolic-ref` reads the link WITHOUT dereferencing it, so a pruned or
     * renamed remote still names a branch. Trusting it would let the rev-list
     * throw, report the branch as current, and say nothing while it is
     * arbitrarily stale. Probing the target is the fall-through.
     */
    const tried: string[] = [];
    const git = {
      run: (args: string[]) => {
        const ref = args[args.length - 1];
        tried.push(ref);
        if (ref === 'refs/remotes/origin/HEAD') return 'origin/gone\n';
        if (ref === 'origin/gone') throw new Error('dangling symref');
        if (ref === 'refs/heads/main') return 'deadbeef\n';
        throw new Error('nope');
      },
    };
    expect(resolveBaseBranch('/repo', git)).toBe('main');
    expect(tried).toContain('origin/gone');
  });

  it('falls back to main then master, qualified as a branch', () => {
    const tried: string[] = [];
    const git = {
      run: (args: string[]) => {
        const ref = args[args.length - 1];
        tried.push(ref);
        if (ref === 'refs/remotes/origin/HEAD') throw new Error('no origin');
        if (ref === 'refs/heads/main') throw new Error('no such ref');
        return 'deadbeef\n';
      },
    };
    expect(resolveBaseBranch('/repo', git)).toBe('master');
    // `refs/heads/`, not the bare name: a tag named main would resolve first.
    expect(tried).toContain('refs/heads/main');
  });

  it('returns null rather than throwing when nothing resolves', () => {
    expect(resolveBaseBranch('/repo', { run: () => { throw new Error('no git'); } })).toBeNull();
  });
});

describe('which branch is measured, and from where', () => {
  it('measures a child IN its parent branch, not against it', () => {
    /*
     * The correction round 1 found: a child has no branch of its own
     * (`agenfk branch create` refuses one) and no tree, so it works in the
     * parent's. Treating that branch as the BASE measured parent..parent,
     * which is zero, so the notice never appeared.
     */
    const parent = { id: 'p', branchName: 'feat/parent', worktreePath: '/wt/parent' };
    expect(driftTargets({ id: 'c', parentId: 'p' }, [parent])).toEqual({
      branch: 'feat/parent',
      repoRoot: '/wt/parent',
    });
  });

  it('walks ALL the way up: a grandchild uses the nearest branching ancestor', () => {
    // EPIC -> STORY -> TASK. The STORY was refused a branch too, so a
    // one-level walk finds nothing and the mandated decomposition goes silent.
    const epic = { id: 'e', branchName: 'feat/epic', worktreePath: '/wt/epic' };
    const story = { id: 's', parentId: 'e' };
    expect(driftTargets({ id: 't', parentId: 's' }, [epic, story])).toEqual({
      branch: 'feat/epic',
      repoRoot: '/wt/epic',
    });
  });

  it('prefers the item own branch and tree when it has them', () => {
    expect(driftTargets({ id: 'x', branchName: 'feat/mine', worktreePath: '/wt/mine' }, [], '/proj')).toEqual({
      branch: 'feat/mine',
      repoRoot: '/wt/mine',
    });
  });

  it('measures HEAD when no branch was ever recorded', () => {
    // Most EPIC-rooted trees never had a branch created by hand. Staying silent
    // would be the difference between firing for most projects and none.
    expect(driftTargets({ id: 'x' }, [], '/proj')).toEqual({ branch: 'HEAD', repoRoot: '/proj' });
  });

  it('answers null only when there is no tree to measure in', () => {
    expect(driftTargets({ id: 'x', branchName: 'feat/x' }, [])).toBeNull();
  });
});

describe('the notice the gatekeeper hands the agent', () => {
  it('says nothing without a branch or a repo root', () => {
    expect(dispatchDriftNotice({ branch: undefined, repoRoot: '/repo', deps: spyGit(5) })).toBe('');
    expect(dispatchDriftNotice({ branch: 'feature/x', repoRoot: undefined, deps: spyGit(5) })).toBe('');
  });

  it('warns below the threshold, because the warning is not the gate', () => {
    // The same split the module documents: the notice is about knowing, the
    // threshold is about waiting, and the gatekeeper only ever does the first.
    const notice = dispatchDriftNotice({ branch: 'feature/x', repoRoot: '/repo', deps: spyGit(1, ['tidy the readme']) });
    expect(notice).toMatch(/moved/);
    expect(notice).toContain('tidy the readme');
  });

  it('is silent when the branch is current', () => {
    expect(dispatchDriftNotice({ branch: 'feature/x', repoRoot: '/repo', deps: spyGit(0) })).toBe('');
  });

  it('never throws when git is unavailable', () => {
    // The gatekeeper runs before every edit; a repository it cannot read must
    // not become a reason the edit is refused.
    expect(dispatchDriftNotice({ branch: 'feature/x', repoRoot: '/repo', deps: { run: () => { throw new Error('nope'); } } })).toBe('');
  });
});
