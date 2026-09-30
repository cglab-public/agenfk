import type { RangeKey } from './components/timelineAxis';

/**
 * The one line a collapsed filter bar shows, so hidden filters are never
 * invisible filters: "30 days · item.closed · all projects". A few values are
 * named, more are counted; an empty selection says what it means.
 */
export function describeFilters(f: {
  range: RangeKey;
  from?: string;
  to?: string;
  types?: string[];
  projects?: string[];
  itemTypes?: string[];
  childHubs?: number;
  /** Anything page-specific, already phrased ("2 developers", "PR #57"). */
  extra?: string[];
}): string {
  const parts: string[] = [];
  parts.push(f.from || f.to ? `${f.from || '…'} → ${f.to || '…'}` : RANGE_LABEL[f.range]);
  // An empty selection filters nothing: every event type applies.
  if (f.types) parts.push(f.types.length === 0 ? 'all event types' : few(f.types, 'event types'));
  if (f.projects) parts.push(f.projects.length === 0 ? 'all projects' : few(f.projects, 'projects', 1));
  if (f.itemTypes?.length) parts.push(few(f.itemTypes, 'item types'));
  if (f.childHubs) parts.push(`${f.childHubs} child hub${f.childHubs === 1 ? '' : 's'}`);
  parts.push(...(f.extra ?? []));
  return parts.join(' · ');
}

const RANGE_LABEL: Record<RangeKey, string> = { today: 'today', '7d': '7 days', '30d': '30 days', '90d': '90 days' };

function few(values: string[], noun: string, max = 2): string {
  return values.length <= max ? values.join(', ') : `${values.length} ${noun}`;
}
