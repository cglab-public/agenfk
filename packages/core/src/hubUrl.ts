/**
 * Hub URL comparison shared by the CLI (login, join, repoint) and the server
 * (hub.json rewrites): the `source` recorded in hub.json names where a URL was
 * learnt, so it is kept only while the URL stays the same one.
 */

/**
 * Whether two Hub URLs are the same endpoint, ignoring trailing slashes. The
 * arguments are `unknown` because one side may come from a hand-edited
 * hub.json; anything that is not a non-empty string is never equal.
 */
export function sameHubUrl(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = stripTrailingSlashes(a.trim());
  const y = stripTrailingSlashes(b.trim());
  return x !== '' && x === y;
}

/**
 * Drops every trailing slash in one pass from the end. Not `/\/+$/`: on a long
 * run of slashes that does not end the string, a backtracking engine rescans
 * the run from every start position, and these values come from a hand-edited
 * hub.json, a managed file or a DNS record.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
}
