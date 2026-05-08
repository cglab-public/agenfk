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
