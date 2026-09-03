// Strip ASCII whitespace + control characters from a git remote URL, then
// lowercase it. This collapses the same repo across fleet members that may
// have different casings or accidental whitespace in their git config.
const REMOTE_URL_NOISE_RE = /[\s\x00-\x1f\x7f]+/g;

// Canonicalise the *form* of a git remote URL so that ssh / https / with-or-
// without-`.git` variants of the same repo collapse to one row. Without this
// /v1/projects (SELECT DISTINCT remote_url) returns one chip per form even
// though the UI's shortRemote() renders them all identically.
//
// Inputs that don't parse are returned with whitespace stripped + lowercased.
const PARSE_REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function sanitizeRemoteUrl(input: string): string {
  const cleaned = input.replace(REMOTE_URL_NOISE_RE, '').toLowerCase();
  const m = cleaned.match(PARSE_REMOTE_RE);
  if (!m) return cleaned;
  const [, host, owner, repo] = m;
  return `git@${host}:${owner}/${repo}.git`;
}

// A bare `owner/repo` slug: exactly two non-empty, slash-free segments, with an
// optional trailing `.git` on the repo. A host-qualified path (`host/owner/repo`)
// or a full URL has more segments / a scheme and therefore does NOT match — we
// leave those to the emitter-resolved remote rather than guessing.
const REPO_SLUG_RE = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/;

// Derive a canonical git remote from the `owner/repo` slug an agent declares in
// a PR payload. PR events often arrive with remoteUrl=null because the emitter's
// `git remote get-url origin` shell-out failed; without this the PR's repo would
// live only in the JSON payload and never reach the remote_url filter dimension.
// owner/repo carries no host, so we assume github.com — where AgEnFK PRs open.
// Returns null for anything that isn't a bare owner/repo. Pass the result
// through sanitizeRemoteUrl to collapse it onto the same chip as real remotes.
export function remoteUrlFromRepo(repo: string): string | null {
  const m = repo.trim().match(REPO_SLUG_RE);
  if (!m) return null;
  return `git@github.com:${m[1]}/${m[2]}.git`;
}

/**
 * CGLAB-131 — a GitHub pull-request link for one PR, for the drill-down list.
 *
 * Preference order, mirroring ingest:
 * 1. the event's authoritative `remote_url` (canonical git form, written at
 *    ingest — emitter-resolved, or derived from the payload slug). A link is
 *    emitted ONLY when the host is exactly github.com: the platform is not
 *    derivable from a custom host (GHE domains, GitLab, …), so guessing would
 *    mint 404s. A non-GitHub host returns null — it does NOT fall back to the
 *    slug, which would assume github.com against an authoritative remote.
 * 2. the payload's `owner/repo` slug, under the same documented github.com
 *    assumption remoteUrlFromRepo() uses, for rows whose remote is missing.
 *
 * prNumber accepts number or string (Postgres jsonb text) and rejects
 * non-positive / non-integer values. Anything unparseable → null; the UI then
 * shows "repo #N" without a link rather than a guess.
 */
export function prUrlFor(
  remoteUrl: string | null | undefined,
  repoSlug: string | null | undefined,
  prNumber: number | string | null | undefined,
): string | null {
  // Coalesce to a plain `number` (Number() is the identity on numbers and
  // parses the PG text form; null/undefined → NaN, rejected below). Without
  // the coalesce the null/undefined arms widen the union and defeat the
  // narrowing on the comparisons that follow.
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (remoteUrl && remoteUrl.trim()) {
    // Stored remotes are already canonical-lowercase; normalise anyway so a
    // pre-canonicalisation row still links (GitHub paths are case-insensitive).
    const m = remoteUrl.trim().replace(REMOTE_URL_NOISE_RE, '').toLowerCase().match(PARSE_REMOTE_RE);
    if (!m) return null;
    const [, host, owner, repo] = m;
    if (host !== 'github.com') return null;
    return `https://github.com/${owner}/${repo}/pull/${n}`;
  }
  if (repoSlug && repoSlug.trim()) {
    const m = repoSlug.trim().replace(REMOTE_URL_NOISE_RE, '').match(REPO_SLUG_RE);
    if (!m) return null; // host-qualified or junk: not a bare slug, don't guess
    return `https://github.com/${m[1]}/${m[2]}/pull/${n}`;
  }
  return null;
}
