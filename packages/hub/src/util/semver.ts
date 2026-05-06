/**
 * Compare two semver-ish version strings (with or without a leading "v").
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * Inputs that don't parse fall back to plain locale string compare so we never
 * throw on malformed data — the hub stores whatever installations report.
 *
 * Prerelease handling follows the semver §11 ordering rules:
 *   - A version without a prerelease ranks above one with the same core +
 *     prerelease (1.0.0 > 1.0.0-rc.1).
 *   - Prerelease identifiers are split by '.' and compared one-by-one.
 *   - Numeric identifiers are compared numerically (so beta.24 > beta.9).
 *   - Numeric identifiers always rank below alphanumeric identifiers
 *     ("beta" > "1" because "1" is numeric and "beta" isn't).
 *   - Shorter prerelease lists rank below longer ones with the same prefix
 *     (1.0.0-alpha < 1.0.0-alpha.1).
 */
const NUMERIC_RE = /^\d+$/;

export function compareSemver(a: string, b: string): number {
  const parse = (s: string) => {
    const m = s.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === '' && pb.pre !== '') return 1;
  if (pa.pre !== '' && pb.pre === '') return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  const ai = a.split('.');
  const bi = b.split('.');
  const len = Math.min(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === y) continue;
    const xNum = NUMERIC_RE.test(x);
    const yNum = NUMERIC_RE.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    // Numeric identifiers always rank below alphanumeric ones (semver §11.4.3).
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  // Common prefix tied — the longer list wins (1.0.0-alpha.1 > 1.0.0-alpha).
  return ai.length - bi.length;
}
