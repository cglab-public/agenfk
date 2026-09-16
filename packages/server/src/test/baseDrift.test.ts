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
import { measureBaseDrift, DISPATCH_STALE_THRESHOLD } from '../baseDrift';

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
