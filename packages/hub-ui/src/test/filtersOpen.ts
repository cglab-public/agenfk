/**
 * The dashboards' filter bar starts collapsed, so a test that drives a facet
 * opens it through the link (`filters=1`) the way a user's shared link would.
 * A test that sets `filters=` itself is about the bar and is left alone.
 */
export function withFiltersOpen(entry: string): string {
  if (/[?&]filters=/.test(entry)) return entry;
  const [path, hash = ''] = entry.split('#');
  return `${path}${path.includes('?') ? '&' : '?'}filters=1${hash ? `#${hash}` : ''}`;
}
