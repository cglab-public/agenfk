import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api } from '../api';
import { TimelineBar } from '../components/TimelineBar';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { FilterAccordion, FILTERS_OPEN, parseFiltersOpen } from '../components/FilterAccordion';
import { describeFilters } from '../filterSummary';
import { MetricsTilesRow, MetricsTotals } from '../components/MetricsTilesRow';
import { ChipRow, Page, QueryState } from '../components/ui';
import { shortRemote } from '../components/facetSearch';
import { mergeEventTypes } from '../eventTypes';
import { fmtRelative } from '../dates';
import { useToggleSet } from '../hooks/useToggleSet';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { useChildHubs } from '../hooks/useChildHubs';
import { csvParam } from '../urlParams';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

interface MetricsResponse { bucket: string; series: Array<{ user_key: string; day: string; events_count: number; items_closed: number; validate_passes: number; validate_fails: number; prs_opened: number }> }
interface UsersResponse { user_key: string; last_seen: string; events_count: number }
interface EventTypesResponse { types: string[] }
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[]; counts?: Record<string, number> }

const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;


const formatLastSeen = fmtRelative;

const ORG_FILTER_KEYS = ['types', 'projects', 'itemTypes', 'range'] as const;
const ORG_LEGACY_KEYS = {
  types: 'agenfk-hub:org:eventTypes',
  projects: 'agenfk-hub:org:projects',
  itemTypes: 'agenfk-hub:org:itemTypes',
};
const readRange = (v: string | null): RangeKey => (RANGES.some(r => r.key === v) ? v : '30d') as RangeKey;

export function OrgPage() {
  // Every filter lives in the URL, so a reload or a shared link shows the same
  // view. A bare visit opens as this browser left it (useUrlFilters).
  const filters = useUrlFilters({ keys: ORG_FILTER_KEYS, storageKey: 'agenfk-hub:org:filters', legacy: ORG_LEGACY_KEYS });
  const fp = filters.params;
  // Default to "shipped today/this week" framing — answers the most common
  // org-level question without requiring a click. `types=` (present, empty)
  // is an explicit "none", not the default.
  const eventTypeSel = useToggleSet(fp.has('types') ? csvParam(fp, 'types') : ['item.closed']);
  const projectSel = useToggleSet(csvParam(fp, 'projects'));
  const itemTypeSel = useToggleSet(csvParam(fp, 'itemTypes'));
  const range = readRange(fp.get('range'));
  const setRange = (r: RangeKey) => filters.write({ range: r });

  // The child hub is in the URL too, but never remembered for a bare visit:
  // it is a scope someone sends, and a stored one would silently narrow the
  // next unrelated visit.
  const [searchParams] = useSearchParams();
  const childHubSel = useToggleSet(csvParam(searchParams, 'childHubId'));
  const childHubs = useChildHubs(childHubSel.set);

  // ONE writer for the query string. React Router's functional setSearchParams
  // hands every call in a commit the same render-time `prev`, so a second
  // effect writing the URL in the same tick silently undid the first.
  const { write: writeFilters } = filters;
  useEffect(() => {
    writeFilters({
      types: [...eventTypeSel.set].join(','),
      projects: projectSel.set.size ? [...projectSel.set].join(',') : null,
      itemTypes: itemTypeSel.set.size ? [...itemTypeSel.set].join(',') : null,
      childHubId: childHubSel.set.size ? [...childHubSel.set].join(',') : null,
    });
  }, [eventTypeSel.set, projectSel.set, itemTypeSel.set, childHubSel.set, writeFilters]);

  // Build the query string once for everything that needs the same filters.
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    p.set('from', fromIsoForRange(new Date(), range));
    return p.toString();
  }, [projectSel.set, itemTypeSel.set, childHubSel.set, range]);

  // For per-itemType counts we honour project + event-type selections but
  // intentionally drop the itemTypes filter — the chip count answers
  // "what would I see if I picked this", which is meaningless if we
  // pre-filter by the active selection.
  const itemTypesQs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    return p.toString();
  }, [projectSel.set, eventTypeSel.set, childHubSel.set]);

  const metrics = useQuery<MetricsResponse>({
    queryKey: ['metrics', qs],
    queryFn: async () => (await api.get(`/v1/metrics${qs ? `?${qs}` : ''}`)).data,
  });
  const users = useQuery<UsersResponse[]>({
    queryKey: ['users', qs],
    queryFn: async () => (await api.get(`/v1/users${qs ? `?${qs}` : ''}`)).data,
  });
  // Both chip lists are partitioned by hub — offering a repo or an event type
  // from a hub the board is not showing is a dead end.
  const hubQs = childHubSel.set.size
    ? `?${new URLSearchParams({ childHubId: [...childHubSel.set].join(',') })}`
    : '';
  const eventTypes = useQuery<EventTypesResponse>({
    queryKey: ['event-types', hubQs],
    queryFn: async () => (await api.get(`/v1/event-types${hubQs}`)).data,
  });
  const projects = useQuery<ProjectsResponse>({
    queryKey: ['projects', hubQs],
    queryFn: async () => (await api.get(`/v1/projects${hubQs}`)).data,
  });
  const itemTypes = useQuery<ItemTypesResponse>({
    queryKey: ['item-types', itemTypesQs],
    queryFn: async () => (await api.get(`/v1/item-types${itemTypesQs ? `?${itemTypesQs}` : ''}`)).data,
  });

  const totals: MetricsTotals = (metrics.data?.series ?? []).reduce(
    (a, r) => ({
      events: a.events + r.events_count,
      closed: a.closed + r.items_closed,
      passes: a.passes + r.validate_passes,
      fails: a.fails + r.validate_fails,
      prsOpened: a.prsOpened + (r.prs_opened ?? 0),
    }),
    { events: 0, closed: 0, passes: 0, fails: 0, prsOpened: 0 },
  );

  const types = mergeEventTypes(eventTypes.data?.types);
  const projectOptions = projects.data?.projects ?? [];
  const itemTypeOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_ITEM_TYPES);
    for (const t of itemTypes.data?.itemTypes ?? []) set.add(t);
    return [...set].sort();
  }, [itemTypes.data]);

  return (
    <Page>
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-accent-ink font-semibold">Dashboard</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Organization rollup</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Fleet-wide AgEnFK activity across every connected installation.</p>
      </header>

      <QueryState query={metrics} label="activity totals">{() => <MetricsTilesRow totals={totals} />}</QueryState>

      {/* The period is always in view; the facets fold behind one summary line. */}
      <div role="group" aria-label="Period" className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-[0.14em] font-semibold text-ink-tertiary">Period</span>
        <div className="inline-flex rounded-lg border border-border-soft bg-canvas p-0.5 text-[11px] font-medium">
          {RANGES.map(r => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={`px-2.5 py-1 rounded-md transition-colors ${range === r.key
                ? 'bg-surface text-accent-ink shadow-sm'
                : 'text-ink-tertiary hover:text-ink'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <FilterAccordion
        activeCount={[projectSel.set, itemTypeSel.set, childHubSel.set].filter(x => x.size > 0).length}
        summary={describeFilters({
          range,
          types: [...eventTypeSel.set],
          projects: [...projectSel.set].map(shortRemote),
          itemTypes: [...itemTypeSel.set],
          childHubs: childHubSel.set.size,
        })}
        open={parseFiltersOpen(searchParams.get(FILTERS_OPEN))}
        onOpenChange={open => filters.write({ [FILTERS_OPEN]: open ? '1' : null })}
      >
        {childHubs.show && (
          <FacetMultiselect
            label="Child hub"
            options={childHubs.options}
            selected={childHubSel.set}
            onToggle={childHubSel.toggle}
            onClear={childHubSel.clear}
            optionLabel={childHubs.label}
            inlineThreshold={6}
            placeholder="Search hubs…"
          />
        )}
        <FacetMultiselect
          label="Project (git remote)"
          options={projectOptions}
          selected={projectSel.set}
          onToggle={projectSel.toggle}
          onClear={projectSel.clear}
          optionLabel={shortRemote}
          inlineThreshold={6}
          placeholder="Search projects…"
        />
        <ChipRow
          label="Item type"
          options={itemTypeOptions}
          selected={itemTypeSel.set}
          onToggle={itemTypeSel.toggle}
          onClear={itemTypeSel.clear}
          optionLabel={(t) => {
            const n = itemTypes.data?.counts?.[t];
            return n == null ? t : `${t} (${n})`;
          }}
        />
        <ChipRow label="Event type" options={types} selected={eventTypeSel.set} onToggle={eventTypeSel.toggle} onClear={eventTypeSel.clear} />
      </FilterAccordion>

      <TimelineBar
        types={[...eventTypeSel.set]}
        projects={[...projectSel.set]}
        itemTypes={[...itemTypeSel.set]}
        childHubs={[...childHubSel.set]}
        title="Activity timeline"
        range={range}
        onRangeChange={setRange}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-secondary">Users</h2>
          {users.data && <span className="text-[11px] text-ink-tertiary">{users.data.length} reporting</span>}
        </div>
        <QueryState
          query={users}
          label="users"
          isEmpty={list => list.length === 0}
          empty={<div className="bg-card-glass border border-border-soft rounded-2xl px-5 py-8 text-center text-sm text-ink-tertiary">No users match the current filters.</div>}
        >
          {list => (
            <div className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl divide-y divide-border-soft overflow-hidden">
              {list.map(u => (
                <Link
                  key={u.user_key}
                  // Carry the hub scope through the click-through: landing on a
                  // person aggregated across every hub would contradict the board
                  // just left, with nothing saying the scope had been dropped.
                  to={`/users/${encodeURIComponent(u.user_key)}${hubQs}`}
                  className="group flex items-center justify-between gap-3 px-5 py-3 hover:bg-accent-fill/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-accent-fill text-accent-ink text-[11px] font-bold flex items-center justify-center shrink-0">
                      {u.user_key.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-[13px] text-ink truncate group-hover:text-accent-ink transition-colors">{u.user_key}</div>
                      <div className="text-[11px] text-ink-tertiary">{u.events_count.toLocaleString()} events · last {formatLastSeen(u.last_seen)}</div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-ink-tertiary group-hover:text-accent-ink transition-colors shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </QueryState>
      </section>
    </Page>
  );
}
