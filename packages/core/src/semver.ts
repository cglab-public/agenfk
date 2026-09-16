/**
 * Semver comparison with correct prerelease ordering.
 *
 * Prerelease identifiers are compared per the semver spec: dot-separated, with
 * numeric identifiers compared NUMERICALLY (so `beta.10` > `beta.8` — a naive
 * lexical compare gets this wrong, which is what left `npx … --beta` stuck on
 * beta.8 and made the upgrade nag recommend an older stable). Shared by the CLI
 * and server; the npx bootstrap keeps its own copy (bin/version-utils.mjs) since
 * it runs before any package is installed.
 */

export interface ParsedSemver {
  core: [number, number, number];
  pre: string[];
}

export function parseSemver(v: string): ParsedSemver | null {
  const m = String(v || '')
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

/** Returns negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));

  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }

  // A version with no prerelease outranks one that has a prerelease.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1; // fewer identifiers sorts lower
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1; // numeric identifiers sort lower than alphanumeric
    if (bn) return 1;
    return ai.localeCompare(bi);
  }
  return 0;
}

/**
 * Hub-only releases (`hub-v*`, CGLAB-8) ship a Docker image and a hub tarball —
 * never the framework. They must never be treated as a framework version.
 *
 * Lives here, next to the comparison they defeat, because the failure is a
 * version-comparison failure: `parseSemver` returns null for a hub tag, and
 * `compareSemver`'s string fallback ranks 'h' above '1', so a hub tag compares
 * GREATER than every real version. Observed in production when `hub-image.yml`
 * created `hub-v1.1.19-beta.1` without `--prerelease`, making it GitHub's
 * "latest stable". Shared by the CLI and server so the rule cannot exist in one
 * consumer and be missing from the next — which is how it first got through.
 */
export function isHubRelease(tag: string | null | undefined): boolean {
  return !!tag && /^hub-v/i.test(tag);
}

/** True only when `candidate` is strictly newer than `current`. */
export function isUpgrade(candidate: string, current: string): boolean {
  if (!candidate || !current) return false;
  // An unparseable version is not an upgrade, it is an unknown. compareSemver
  // falls back to localeCompare so that sorting still works, but that fallback
  // ranks letters above digits — which made a hub tag look like a newer release
  // and let its upgrade tier through. This answer gates enforcement, and a
  // `mandatory` tier calls process.exit(1) on every CLI invocation, so the
  // conservative reading is the only safe one. Hub tags are named explicitly
  // rather than left to fall through: they are a known release line, not noise.
  if (isHubRelease(candidate) || isHubRelease(current)) return false;
  if (!parseSemver(candidate) || !parseSemver(current)) return false;
  return compareSemver(candidate, current) > 0;
}
