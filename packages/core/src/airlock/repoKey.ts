/**
 * The key a per-project override is stored under: the project's REPOSITORY,
 * host/owner/repo, the same whatever form its git remote is written in (scp,
 * https, ssh://, with or without a user, a port, `.git` or a trailing slash).
 * A bare owner/repo is on github.com. A standalone project with no remote is
 * keyed project:<local id>. Anything else is no key at all (null).
 */
const SEGMENT = /^[a-z0-9._-]+$/;
const PROJECT_KEY = /^project:[A-Za-z0-9_-]{1,128}$/;
/** No git remote is longer: anything that is, is no key (and costs nothing to refuse). */
const MAX_REMOTE_CHARS = 2048;

/** `s` without its trailing slashes, then without every trailing `.git` - from the end, no regex: linear (CodeQL). */
function stripTrailing(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  while (end >= 4 && s.startsWith('.git', end - 4)) end -= 4;
  return s.slice(0, end);
}

export function airlockRepoKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_REMOTE_CHARS) return null;
  const s = raw.trim();
  if (PROJECT_KEY.test(s)) return s;
  let rest = s.toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  else {
    // scp form: [user@]host:owner/repo
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(rest);
    if (scp) rest = `${scp[1]}/${scp[2]}`;
  }
  // Every trailing .git, so a key normalised again is itself.
  rest = stripTrailing(rest.replace(/^[^@/]*@/, ''));
  const parts = rest.split('/');
  if (parts.length === 2) parts.unshift('github.com');
  if (parts.length < 3) return null;
  parts[0] = parts[0].replace(/:\d+$/, '');
  if (!parts[0].includes('.') || !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return null;
  return parts.join('/');
}
