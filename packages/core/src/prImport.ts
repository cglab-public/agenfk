/**
 * Turning an existing Pull Request into a card (CGLAB-177).
 *
 * The decisions live here, apart from the route, because every one of them is a
 * judgement call that had to be argued rather than a mechanical translation —
 * and an argument that only exists inside an Express handler can only be
 * checked by standing up a server and a GitHub credential.
 *
 * THE FOUR RULES, and why each is what it is:
 *
 *  1. A card whose branch already matches is REUSED, never duplicated. Not a
 *     preference: git refuses to check one branch out into two worktrees, so a
 *     second card on the same branch is a failure scheduled for later.
 *
 *  2. Only the PR BODY becomes the description. Comments and reviews are a
 *     conversation that goes on living on GitHub; a snapshot of them inside a
 *     card is a second copy nobody will update. The link is what does not go
 *     stale.
 *
 *  3. A fork's head branch does not exist on our remote, so no fetch is
 *     attempted for one. Spending a network round trip to produce an error
 *     already known is worse than saying so.
 *
 *  4. When the worktree cannot be made, the CARD SURVIVES. This is a deliberate
 *     divergence from `tasks-from-branch`, which rolls the item back — there the
 *     item exists only to hold a worktree, here it represents a PR that exists
 *     whether or not the network does. What must not happen is silence, so the
 *     reason travels with the result.
 */

/** The fields read off `gh pr view`. Everything else is ignored on purpose. */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /** The PR's source branch. Remote, which is the whole difficulty. */
  readonly headRefName: string;
  readonly state: string;
  /** True when the PR comes from a fork, so headRefName is not on our remote. */
  readonly isCrossRepository: boolean;
}

/** The little a card has to expose for the reuse check. */
export interface ExistingCard {
  readonly id: string;
  readonly title: string;
  readonly branchName?: string | null;
}

export interface WorktreeIntent {
  readonly attempt: boolean;
  /** Said out loud either way — a skipped worktree with no reason reads as a bug. */
  readonly reason: string;
}

export type PrImportPlan =
  | { readonly action: 'reuse'; readonly itemId: string; readonly reason: string }
  | {
      readonly action: 'create';
      readonly title: string;
      readonly description: string;
      readonly branchName: string;
      readonly externalId: string;
      readonly externalUrl: string;
      readonly worktree: WorktreeIntent;
    };

/**
 * Is this something `gh pr view` can be asked for?
 *
 * The number is interpolated into a `gh` shellout. The issue importer carries a
 * comment naming the bug this was (4c939916) and the lesson is not "issues need
 * this" — it is that anything reaching argv does. Integer, positive, and passed
 * as its own argv entry.
 */
export function isValidPrNumber(value: unknown): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

/**
 * A branch name git will accept, and that nothing downstream can reinterpret.
 *
 * `headRefName` comes back from GitHub, so it is not attacker-chosen in the
 * usual sense — but it does end up in `git fetch` and `git worktree add`, and
 * "it came from an API we trust" is exactly where that assumption stops being
 * safe. Refuses rather than sanitises, the same posture as the session id and
 * the tmux name.
 */
export function isUsableBranchName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n !== name) return false;
  // A leading dash is read as an option by every git subcommand this feeds.
  if (n.startsWith('-')) return false;
  // git's own refname rules, the subset that matters here.
  if (n.startsWith('/') || n.endsWith('/') || n.endsWith('.lock')) return false;
  if (n.includes('..') || n.includes('@{')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return false;
  return true;
}

/**
 * The description a PR card starts with.
 *
 * Body plus a link, and nothing else. An empty body is left empty rather than
 * filled with an apology — the link is already there, and a card whose
 * description says "no description provided" is worse than one that says
 * nothing.
 */
export function descriptionFor(pr: PullRequestSummary): string {
  const body = typeof pr.body === 'string' ? pr.body.trim() : '';
  const link = `PR #${pr.number}: ${pr.url}`;
  return body ? `${body}\n\n${link}` : link;
}

/**
 * What to do about this PR, given the cards that already exist.
 *
 * Pure: takes the PR and the candidate cards, returns the decision. No network,
 * no git, no storage — which is what lets the fork case, the deleted-branch case
 * and the duplicate case be written down instead of reproduced.
 */
export function planPrImport(
  pr: PullRequestSummary,
  existingCards: readonly ExistingCard[],
): PrImportPlan {
  const branch = typeof pr.headRefName === 'string' ? pr.headRefName.trim() : '';

  // Rule 1. Matched on the BRANCH and not on the PR number, because the branch
  // is what collides in git — a card made by `From Branch` before the PR
  // existed has no PR number on it and is still the same work.
  const already = existingCards.find(c => (c.branchName ?? '').trim() === branch && branch !== '');
  if (already) {
    return {
      action: 'reuse',
      itemId: already.id,
      reason: `"${already.title}" is already on branch ${branch}. Git allows one worktree per branch, so this opens that card instead of making a second.`,
    };
  }

  return {
    action: 'create',
    title: pr.title,
    description: descriptionFor(pr),
    branchName: branch,
    externalId: String(pr.number),
    externalUrl: pr.url,
    worktree: worktreeIntentFor(pr, branch),
  };
}

function worktreeIntentFor(pr: PullRequestSummary, branch: string): WorktreeIntent {
  if (pr.isCrossRepository) {
    // Rule 3.
    return {
      attempt: false,
      reason: `PR #${pr.number} comes from a fork, so ${branch || 'its branch'} is not on this repository's remote. The card is created without a worktree.`,
    };
  }
  if (!isUsableBranchName(branch)) {
    return {
      attempt: false,
      reason: `PR #${pr.number} has no branch name this can safely hand to git. The card is created without a worktree.`,
    };
  }
  // A merged or closed PR usually has its branch deleted — but "usually" is not
  // "always", and refusing on the state would be guessing at the remote instead
  // of asking it. The fetch is allowed to fail and say so.
  return { attempt: true, reason: `Fetching ${branch} from the remote.` };
}
