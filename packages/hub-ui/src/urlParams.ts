/**
 * Read a comma-separated facet selection out of the query string.
 *
 * The hub's list filters are all CSV — ?projects=a,b — and the server parses
 * them with the same "split, trim, drop empties" rule (parseList in
 * routes/queries.ts). Keeping one implementation on this side means a link
 * cannot mean one thing to the address bar and another to the API: a trailing
 * comma or a stray space is dropped identically at both ends.
 *
 * An absent or empty param yields [], which every facet reads as "no selection"
 * and the server reads as "all" — the same default from both directions.
 */
export function csvParam(params: URLSearchParams, key: string): string[] {
  return (params.get(key) ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
