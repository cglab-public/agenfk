/**
 * Measure a copy before starting it, and refuse before the first byte
 * (CGLAB-196).
 *
 * WHY THE REFUSAL MUST COME BEFORE ANY WRITING, and not mid-copy where it
 * would be easier: `fs.cp` IGNORES its `signal` option. A copy that has started
 * cannot be cancelled, so aborting halfway leaves a partial tree that nobody -
 * not the next agent, not the person looking at it - can interpret. Refusing
 * before the first byte keeps the worktree in a state somebody can reason
 * about, and that is worth walking the tree twice for.
 *
 * THE ENTRY COUNT MATTERS AS MUCH AS THE BYTES. 200,000 tiny files weigh
 * almost nothing and take minutes, so a budget in bytes alone passes exactly
 * the payload that freezes worktree creation. Both limits are real limits.
 *
 * What these numbers clear and what they refuse is the whole design: `.env`
 * files, `.vscode/`, a small build cache - yes. A dependency tree - no. In
 * this repository that is 939 MB against 8.1 MB of source, and copying it per
 * worktree is the thing this exists to prevent.
 */

/** Two gigabytes. Above this, per worktree, is not a copy anybody wants. */
export const MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;

/** Fifty thousand entries. See the header: the count is its own limit. */
export const MAX_COPY_ENTRIES = 50_000;

/**
 * Headroom for the SIZING walk, so one refused directory cannot starve the
 * small entries listed after it.
 *
 * Without it, measuring a `node_modules` listed first would hit the budget and
 * stop, and the `.env` further down the list would be refused for a reason
 * that has nothing to do with it.
 */
export const SIZING_HEADROOM = 4;

export interface CopyEntry {
  readonly path: string;
  readonly bytes: number;
  readonly entries: number;
}

export interface CopyPlan {
  /** Entries that fit, in the order given. */
  readonly accepted: readonly string[];
  /** Entries refused, each with the reason naming which limit and by how much. */
  readonly refused: readonly { path: string; reason: string }[];
  readonly totalBytes: number;
  readonly totalEntries: number;
}

export interface CopyBudget {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

const DEFAULT_BUDGET: CopyBudget = { maxBytes: MAX_COPY_BYTES, maxEntries: MAX_COPY_ENTRIES };

/**
 * Decide what may be copied, having measured everything first.
 *
 * Each entry is judged ON ITS OWN rather than against a running total. A
 * repository that lists `node_modules` and `.env` should get its `.env`: the
 * first is refused for being what it is, and letting it consume the budget
 * would refuse the second for a reason that has nothing to do with it.
 */
export function planCopy(
  entries: readonly CopyEntry[],
  budget: CopyBudget = DEFAULT_BUDGET,
): CopyPlan {
  const accepted: string[] = [];
  const refused: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  let totalEntries = 0;

  for (const entry of entries) {
    if (entry.bytes > budget.maxBytes) {
      refused.push({
        path: entry.path,
        reason: `${entry.path} is ${gb(entry.bytes)} and the per-worktree limit is ${gb(budget.maxBytes)}. `
          + 'This list is for the small things each worktree must own - a .env, an editor setting, '
          + 'a build cache. A dependency tree is installed, not copied.',
      });
      continue;
    }
    if (entry.entries > budget.maxEntries) {
      /*
       * Named separately, because "too big" would be wrong and confusing here:
       * the thing is small and slow, and somebody told it was too large would
       * go looking for size to reduce.
       */
      refused.push({
        path: entry.path,
        reason: `${entry.path} holds ${entry.entries.toLocaleString()} files and the limit is `
          + `${budget.maxEntries.toLocaleString()}. It is not large, it is numerous - `
          + 'copying it takes minutes whatever it weighs.',
      });
      continue;
    }
    accepted.push(entry.path);
    totalBytes += entry.bytes;
    totalEntries += entry.entries;
  }

  return { accepted, refused, totalBytes, totalEntries };
}

/**
 * How far a sizing walk may go before giving up on one entry.
 *
 * Bounded so measuring cannot itself become the slow thing it exists to
 * prevent: past this the entry is refused unmeasured, which is the same
 * verdict it would have got.
 */
export function sizingLimit(budget: CopyBudget = DEFAULT_BUDGET): CopyBudget {
  return {
    maxBytes: budget.maxBytes * SIZING_HEADROOM,
    maxEntries: budget.maxEntries * SIZING_HEADROOM,
  };
}

function gb(bytes: number): string {
  const g = bytes / (1024 * 1024 * 1024);
  return g >= 1 ? `${g.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}
