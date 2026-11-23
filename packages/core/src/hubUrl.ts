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
  const x = a.trim().replace(/\/+$/, '');
  const y = b.trim().replace(/\/+$/, '');
  return x !== '' && x === y;
}
