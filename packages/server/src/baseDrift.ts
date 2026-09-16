/**
 * How far a card's branch has fallen behind, and what to say about it
 * (CGLAB-197).
 *
 * An agent that starts work against a base that has moved is working against a
 * world that no longer exists, and finds out at the merge - which is the most
 * expensive moment available.
 *
 * TWO HALVES, AND THEY ARE INDEPENDENT. That separation is the whole design,
 * and collapsing it is the obvious mistake:
 *
 *   THE WARNING GOES OUT whenever the branch is behind at all, with what
 *   landed. Knowing the base moved is useful even when the dispatch proceeds
 *   normally - most drift is harmless and worth a glance, not a stop.
 *
 *   THE THRESHOLD ONLY DECIDES WHETHER THE DISPATCH WAITS. It is a SKIP: the
 *   card stays ready and is picked up again next round, not refused for good.
 *
 * Tying the warning to the threshold produces the worst design available -
 * blocking silently below it, and saying nothing until it is too late to be
 * cheap.
 *
 * Injectable runner, like closeCommit and gitStatus, so the ARGUMENT LIST is
 * something a test can read back. Every git defect found in this server was
 * invisible until the arguments were observable.
 */

/** Commits behind before a dispatch waits for a rebase. */
export const DISPATCH_STALE_THRESHOLD = 20;

export interface BaseDriftDeps {
  /** Run git with these arguments and return stdout. Throws if git fails. */
  readonly run: (args: string[]) => string;
}

export interface BaseDrift {
  /** Commits on the base that this branch does not have. */
  readonly behind: number;
  /** The base it was compared against. */
  readonly base: string;
  /** Subjects of what landed, newest first. Empty when not behind. */
  readonly landed: readonly string[];
  /**
   * Whether the dispatch should WAIT. Never a permanent refusal - the card
   * stays ready and is retried, so this is "not yet" rather than "no".
   */
  readonly shouldWait: boolean;
  /**
   * What to tell the agent, or null when the branch is current.
   *
   * Present whenever it is behind AT ALL, independent of `shouldWait`: the
   * point of the warning is that it arrives while acting on it is still cheap.
   */
  readonly notice: string | null;
}

const CURRENT = (base: string): BaseDrift =>
  ({ behind: 0, base, landed: [], shouldWait: false, notice: null });

/**
 * Measure one branch against its base.
 *
 * Never throws. A card being dispatched is a workflow fact, and failing to
 * measure drift must not stop it - an unmeasurable branch reports as current,
 * which is the generous reading and the one that cannot invent a blockage.
 */
export function measureBaseDrift(
  branch: string,
  base: string,
  repoRoot: string,
  deps: BaseDriftDeps,
  threshold: number = DISPATCH_STALE_THRESHOLD,
): BaseDrift {
  const at = (...args: string[]): string[] => ['-C', repoRoot, ...args];

  let behind = 0;
  try {
    // `base..branch` counts what BASE has and branch does not. The direction
    // is easy to reverse and the reversed number is meaningless but plausible,
    // which is the worst kind of wrong.
    const out = deps.run(at('rev-list', '--count', `${branch}..${base}`));
    behind = Number.parseInt(out.trim(), 10);
  } catch {
    return CURRENT(base);
  }
  if (!Number.isFinite(behind) || behind <= 0) return CURRENT(base);

  let landed: string[] = [];
  try {
    /*
     * The SUBJECTS, not the count alone. "20 commits behind" tells an agent
     * nothing it can act on; "the file you are about to edit was rewritten"
     * does, and it can only see that if it is told what landed.
     */
    const log = deps.run(at('log', '--format=%s', '--max-count=10', `${branch}..${base}`));
    landed = log.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    landed = [];
  }

  const shouldWait = behind > threshold;
  return {
    behind,
    base,
    landed,
    shouldWait,
    notice:
      `The base ${base} has moved: ${behind} commit${behind === 1 ? '' : 's'} you do not have.\n`
      + landed.map(s => `  - ${s}`).join('\n')
      + (shouldWait
        ? `\nThat is past the ${threshold}-commit threshold, so this dispatch waits for a rebase. `
          + 'The card stays ready and will be picked up again.'
        : '\nIf any of that touches what you are about to change, pull it in first.'),
  };
}
