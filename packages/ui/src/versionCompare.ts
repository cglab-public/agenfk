/**
 * "Is there a newer version" — asked in one place.
 *
 * This lived inside `ReleaseReminder.tsx` as a file-local function. The
 * settings screen asks the same question, and the obvious move — write the
 * comparison again beside the new caller — produces two functions that agree
 * until they do not. The visible failure is specific and silly: the reminder
 * rocket lights up in the corner while the settings row two clicks away says
 * "You're up to date".
 */

/**
 * Is `latest` newer than `current`?
 *
 * Semver order, prerelease included (BUG 61bc10b0): the suffix used to be
 * dropped, so the stable that graduates a beta (2.0.0 against 2.0.0-beta.12)
 * read as the same version and the board never announced it, and a newer beta
 * read as no update. A beta of the version you already run is still not an
 * upgrade (1.1.18-beta.6 against 1.1.18), and 1.2.0-beta.1 against 1.1.18 is.
 *
 * The same rule as core's isUpgrade, which the CLI notice and the tier gate
 * use. The board cannot import @agenfk/core at runtime (it compiles to
 * CommonJS, see claimState.ts), so this is a copy, pinned against the real one
 * by versionCompare.test.ts.
 *
 * Answers `false` for anything it cannot compare, and for a hub release
 * (`hub-v*`, never a framework version). The release query goes to the network
 * and may never answer, and "no update" is the safe reading of "we do not
 * know" - the settings row says the same thing a different way, by declining
 * to claim you are up to date until it has been told.
 */
interface ParsedSemver { core: [number, number, number]; pre: string[] }

function parseSemver(v: string): ParsedSemver | null {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1;
    if (yn) return 1;
    return x.localeCompare(y);
  }
  return 0;
}

const isHubRelease = (tag: string) => /^hub-v/i.test(tag);

export function isNewerVersion(latest: string, current: string): boolean {
  if (!latest || !current) return false;
  if (isHubRelease(latest) || isHubRelease(current)) return false;
  const l = parseSemver(latest), c = parseSemver(current);
  if (!l || !c) return false;
  return compareSemver(l, c) > 0;
}
