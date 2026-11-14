/**
 * Semver comparison for the npx bootstrap (bin/agenfk.js). Kept as a tiny,
 * dependency-free copy because the bootstrap runs before any package is built or
 * installed, so it cannot import @agenfk/core. Mirror of packages/core/src/semver.ts.
 *
 * Prerelease identifiers compare per spec: numeric identifiers numerically, so
 * `1.1.0-beta.10` > `1.1.0-beta.8`. A naive lexical compare gets this backwards
 * ('1' < '8'), which made the downgrade guard skip beta.10 and pin npx --beta to
 * beta.8.
 */

export function parseSemver(v) {
  const m = String(v || '')
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

/** Returns negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));

  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1;
    if (bn) return 1;
    return ai.localeCompare(bi);
  }
  return 0;
}

/**
 * Hub image releases (`hub-v*`) are a separate release line in the same repo,
 * never the framework (mirror of @agenfk/core's isHubRelease).
 */
export function isHubRelease(tag) {
  return /^hub-v/i.test(String(tag || ''));
}

/**
 * The release a channel installs (BUG 4bd98e16), the same rule as the CLI's
 * newestChannelRelease: never a hub tag, only the channel's kind (prerelease
 * for --beta, stable otherwise), and the newest by VERSION, publish date only
 * breaking ties - by date, a hub image or a hotfix on an older line published
 * last would win. An unparseable tag sorts below any parseable one.
 * `refs`: [{ tag, prerelease, publishedAt }]. Returns the tag, or null.
 */
export function newestChannelTag(refs, beta) {
  const match = (refs || [])
    // Stable never takes a tag with a prerelease part, even one published
    // without --prerelease (the CLI's rule too).
    .filter((r) => r && r.tag && !isHubRelease(r.tag) && !!r.prerelease === !!beta
      && (beta || !(parseSemver(r.tag)?.pre.length)))
    .sort((a, b) => {
      const pa = parseSemver(a.tag), pb = parseSemver(b.tag);
      if (pa && pb) {
        const byVersion = compareSemver(b.tag, a.tag);
        if (byVersion !== 0) return byVersion;
      } else if (pa || pb) {
        return pa ? -1 : 1;
      }
      return (b.publishedAt || 0) - (a.publishedAt || 0);
    })[0];
  return match ? match.tag : null;
}
