import { compareSemver, isHubRelease, isUpgrade, parseSemver } from './semver';

/**
 * Which framework release is "the latest stable", and how hard it must be
 * pushed (BUGs 022b229a, 3a261573). One rule for the server's /releases/latest
 * and the CLI's direct-GitHub fallback, so the tier gate, the MCP notice and
 * `agenfk upgrade` never disagree about the version.
 *
 * GitHub's /releases/latest picks by DATE: a hotfix on an older line published
 * last, or a hub build made without --prerelease, would be "latest". So it is
 * only one candidate beside the release list, and the newest framework stable
 * by VERSION wins.
 */
export interface GitHubRelease {
  tag_name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
}

export type UpgradeTier = 'mandatory' | 'recommended' | 'optional';

/** A framework stable: not a hub build, not a draft, not flagged or named a prerelease. */
export function isFrameworkStable(r: GitHubRelease | null | undefined): boolean {
  if (!r || typeof r.tag_name !== 'string' || !r.tag_name) return false;
  if (isHubRelease(r.tag_name) || r.prerelease || r.draft) return false;
  const v = parseSemver(r.tag_name);
  return !!v && v.pre.length === 0;
}

/** Framework stables, newest by version first, one per tag. */
function rankedStables<T extends GitHubRelease>(releases: Array<T | null | undefined>): T[] {
  const seen = new Set<string>();
  return (releases.filter(isFrameworkStable) as T[])
    .sort((a, b) => compareSemver(b.tag_name as string, a.tag_name as string))
    .filter((r) => (seen.has(r.tag_name as string) ? false : (seen.add(r.tag_name as string), true)));
}

/** The newest framework stable by version, or null. */
export function newestFrameworkStable<T extends GitHubRelease>(releases: Array<T | null | undefined>): T | null {
  return rankedStables(releases)[0] ?? null;
}

/**
 * The framework stables newer than `current`, NEAREST the install first, at
 * most `cap`: the releases whose upgrade tier applies to an install on
 * `current`. Nearest first because that is where a mandatory hotfix for the
 * installed line sits; capping newest-first would drop exactly it once a dozen
 * newer releases exist (022b229a re-review).
 */
export function newerFrameworkStables<T extends GitHubRelease>(
  releases: Array<T | null | undefined>, current: string, cap = 10,
): T[] {
  return rankedStables(releases).filter((r) => isUpgrade(r.tag_name as string, current)).reverse().slice(0, cap);
}

const TIER_RANK: Record<UpgradeTier, number> = { optional: 0, recommended: 1, mandatory: 2 };

/**
 * The strongest tier among releases newer than the installed one (user
 * decision, 022b229a review): a mandatory hotfix on an older line still gates,
 * and `agenfk upgrade` - which installs the newest - satisfies it.
 */
export function strongestTier(tiers: unknown[]): UpgradeTier {
  let best: UpgradeTier = 'optional';
  for (const t of tiers) {
    if ((t === 'mandatory' || t === 'recommended') && TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}
