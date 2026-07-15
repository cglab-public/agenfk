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
