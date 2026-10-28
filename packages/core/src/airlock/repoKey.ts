/**
 * The key a per-project override is stored under: the project's REPOSITORY,
 * host/owner/repo, the same whatever form its git remote is written in (scp,
 * https, ssh://, with or without a user, a port, `.git` or a trailing slash).
 * A bare owner/repo is on github.com. A standalone project with no remote is
 * keyed project:<local id>. Anything else is no key at all (null).
 */
const SEGMENT = /^[a-z0-9._-]+$/;
const PROJECT_KEY = /^project:[A-Za-z0-9_-]{1,128}$/;

export function airlockRepoKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
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
  rest = rest.replace(/^[^@/]*@/, '').replace(/\/+$/, '').replace(/(?:\.git)+$/, '');
  const parts = rest.split('/');
  if (parts.length === 2) parts.unshift('github.com');
  if (parts.length < 3) return null;
  parts[0] = parts[0].replace(/:\d+$/, '');
  if (!parts[0].includes('.') || !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return null;
  return parts.join('/');
}
