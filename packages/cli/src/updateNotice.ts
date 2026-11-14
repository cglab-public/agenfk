import { compareSemver, isUpgrade, parseSemver } from '@agenfk/core';

/** The release bare `agenfk` offers, and the command that installs it. */
export interface UpdateNotice { version: string; command: string }

/**
 * Which release, if any, to offer as an update (b60bc8bf).
 *
 * The newest release the user's channel reaches: the latest stable, and on a
 * prerelease also the latest beta - so a beta hears about the next beta AND
 * about the stable that graduates it, and a stable never hears about betas.
 * Only a strictly newer one counts: the notice used to fire on any difference,
 * which offered 1.1.20 to 2.0.0-beta.12. `isUpgrade` treats an unreadable or
 * hub tag as unknown, never as newer.
 */
export function updateNotice(current: string, latest: { stable?: string | null; beta?: string | null }): UpdateNotice | null {
  const onPrerelease = isPrerelease(current);
  const candidates: UpdateNotice[] = [];
  // A beta published without --prerelease is "the latest stable" to GitHub; a
  // stable install is never pointed at one.
  if (latest.stable && (onPrerelease || !isPrerelease(latest.stable))) {
    candidates.push({ version: latest.stable.replace(/^v/, ''), command: 'agenfk upgrade' });
  }
  if (onPrerelease && latest.beta) candidates.push({ version: latest.beta.replace(/^v/, ''), command: 'agenfk upgrade --beta' });
  const newer = candidates.filter((c) => isUpgrade(c.version, current));
  if (newer.length === 0) return null;
  return newer.sort((a, b) => compareSemver(b.version, a.version))[0];
}

/** Whether a version carries a prerelease part (`-beta.12`, `-rc.1`). */
export function isPrerelease(version: string): boolean {
  return (parseSemver(version)?.pre.length ?? 0) > 0;
}

/**
 * Fetch what `updateNotice` needs and decide. The beta channel is asked only on
 * a prerelease, and one channel failing does not hide the other.
 */
export async function findUpdateNotice(
  current: string,
  latestTag: (beta: boolean) => Promise<string>,
): Promise<UpdateNotice | null> {
  const [stable, beta] = await Promise.all([
    latestTag(false).catch(() => null),
    isPrerelease(current) ? latestTag(true).catch(() => null) : Promise.resolve(null),
  ]);
  return updateNotice(current, { stable, beta });
}
