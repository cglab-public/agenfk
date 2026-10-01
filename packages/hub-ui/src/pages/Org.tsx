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
import { ChipRow, DataTable, Page, PageHeader, PeriodControl, QueryState } from '../components/ui';
import { shortRemote } from '../components/facetSearch';
import { mergeEventTypes } from '../eventTypes';
import { EventTypeChips } from '../components/EventTypeChips';
import { fmtRelative, utcTitle } from '../dates';
import { checkPassRate } from '../checkPassRate';
import { buildDayAxis } from '../prOverview';
import { Sparkline } from '../components/Sparkline';
import { useToggleSet } from '../hooks/useToggleSet';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { usePeopleNames } from '../hooks/usePeopleNames';
import { PersonAvatar } from '../components/PersonName';
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
interface UsersResponse {
  user_key: string;
  last_seen: string;
  /** Events matching the Event type filter. */
  events_count: number;
  // What the person got done, over every event type (the hub computes these
  // in the same request, under every other filter).
  items_closed: number;
  validate_passes: number;
  validate_fails: number;
  prs_opened: number;
  /** Items closed per UTC day. */
  closed_daily: Record<string, number>;
}
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
  // The Users panel counts what the Event type filter selects, like the chart
  // beside it. The tiles above deliberately do not (and say so).
  const usersQs = useMemo(() => {
    const p = new URLSearchParams(qs);
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    return p.toString();
  }, [qs, eventTypeSel.set]);
  const typeScoped = eventTypeSel.set.size > 0;
  const nameOf = usePeopleNames();
  const users = useQuery<UsersResponse[]>({
    queryKey: ['users', usersQs],
    // Missing counts read as none rather than crashing a cell.
    queryFn: async () => ((await api.get(`/v1/users${usersQs ? `?${usersQs}` : ''}`)).data as Partial<UsersResponse>[])
      .map(u => ({ items_closed: 0, validate_passes: 0, validate_fails: 0, prs_opened: 0, closed_daily: {}, ...u }) as UsersResponse),
  });
  // Closures per UTC day (the hub groups by UTC date), over the period. An
  // item reopened and closed again counts once in Items closed but on each
  // day it closed here, so the line is labelled closures, not items.
  const activityAxis = useMemo(
    () => buildDayAxis(fromIsoForRange(new Date(), range), new Date().toISOString(), 'UTC'),
    [range],
  );

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
      {/* The period is always in view, in the header toolbar as on PR overview;
          the facets fold behind one summary line. */}
      <PageHeader
        eyebrow="Dashboard"
        title="Organization rollup"
        subtitle="Fleet-wide AgEnFK activity across every connected installation."
        toolbar={(
          <PeriodControl ranges={RANGES} active={range} onPick={setRange} />
        )}
      />

      <div className="space-y-1.5">
        <p className="text-[11px] text-ink-tertiary">Totals apply every filter except event type.</p>
        <QueryState query={metrics} label="activity totals">{() => <MetricsTilesRow totals={totals} selectedTypes={eventTypeSel.set} onFilterTypes={eventTypeSel.replace} />}</QueryState>
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
        <EventTypeChips options={types} selected={eventTypeSel.set} onToggle={eventTypeSel.toggle} onClear={eventTypeSel.clear} />
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
          {/* Scoped to the event types when some are picked: say so, or a person
              active a minute ago drops out of "reporting" for no visible reason. */}
          {users.data && <span className="text-[11px] text-ink-tertiary">{users.data.length} {typeScoped ? 'with matching events' : 'reporting'}</span>}
        </div>
        <QueryState
          query={users}
          label="users"
          isEmpty={list => list.length === 0}
          empty={<div className="bg-card-glass border border-border-soft rounded-2xl px-5 py-8 text-center text-sm text-ink-tertiary">No users match the current filters.</div>}
        >
          {list => (
            <div className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
              {typeScoped && (
                <p className="px-5 pt-3 text-[11px] text-ink-tertiary">
                  Listed by matching events. Items closed, check pass rate and PRs count every event type.
                </p>
              )}
              <DataTable
                caption="Users"
                minWidth={860}
                rows={list}
                rowKey={u => u.user_key}
                defaultSort={{ key: 'last', dir: 'desc' }}
                // Only the person links; a hovered row would promise more.
                rowHover={false}
                search={{
                  label: 'Search people',
                  placeholder: 'Search by name or email',
                  matches: (u, q) => `${nameOf(u.user_key) ?? ''} ${u.user_key}`.toLowerCase().includes(q.toLowerCase()),
                }}
                columns={[
                  {
                    key: 'person',
                    header: 'Person',
                    sortValue: u => (nameOf(u.user_key) ?? u.user_key).toLowerCase(),
                    render: u => (
                      <Link
                        // Carry the hub scope through the click-through: landing on a
                        // person aggregated across every hub would contradict the board
                        // just left, with nothing saying the scope had been dropped.
                        to={`/users/${encodeURIComponent(u.user_key)}${hubQs}`}
                        className="group flex items-center gap-3 min-w-0 max-w-[320px]"
                      >
                        <PersonAvatar name={nameOf(u.user_key)} userKey={u.user_key} />
                        <div className="min-w-0">
                          {nameOf(u.user_key) ? (
                            <>
                              <div className="text-[13px] text-ink truncate group-hover:text-accent-ink transition-colors">{nameOf(u.user_key)}</div>
                              <div className="font-mono text-[11px] text-ink-tertiary truncate">{u.user_key}</div>
                            </>
                          ) : (
                            <div className="font-mono text-[13px] text-ink truncate group-hover:text-accent-ink transition-colors">{u.user_key}</div>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-ink-tertiary group-hover:text-accent-ink transition-colors shrink-0 ml-auto" />
                      </Link>
                    ),
                  },
                  {
                    key: 'closed',
                    header: 'Items closed',
                    align: 'right',
                    firstDir: 'desc',
                    sortValue: u => u.items_closed,
                    render: u => <span className="font-mono tabular-nums text-ink">{u.items_closed.toLocaleString()}</span>,
                  },
                  {
                    key: 'rate',
                    header: 'Check pass rate',
                    align: 'right',
                    firstDir: 'desc',
                    // No checks sorts below any rate.
                    sortValue: u => checkPassRate(u.validate_passes, u.validate_fails) ?? -1,
                    render: u => {
                      const pct = checkPassRate(u.validate_passes, u.validate_fails);
                      return pct === null
                        ? <span className="text-ink-tertiary" title="no checks ran">—</span>
                        : <span className="font-mono tabular-nums text-ink" title={`${u.validate_passes} passed · ${u.validate_fails} failed`}>{pct}%</span>;
                    },
                  },
                  {
                    key: 'prs',
                    header: 'PRs',
                    align: 'right',
                    firstDir: 'desc',
                    sortValue: u => u.prs_opened,
                    render: u => <span className="font-mono tabular-nums text-ink">{u.prs_opened.toLocaleString()}</span>,
                  },
                  {
                    key: 'activity',
                    header: 'Closed per day',
                    render: u => <Sparkline daily={u.closed_daily} axis={activityAxis} label="Closures" />,
                  },
                  {
                    key: 'events',
                    header: typeScoped ? 'Matching events' : 'Events',
                    align: 'right',
                    firstDir: 'desc',
                    sortValue: u => u.events_count,
                    render: u => <span className="font-mono tabular-nums text-ink">{u.events_count.toLocaleString()}</span>,
                  },
                  {
                    key: 'last',
                    header: typeScoped ? 'Last match' : 'Last active',
                    align: 'right',
                    firstDir: 'desc',
                    sortValue: u => Date.parse(u.last_seen) || 0,
                    render: u => <span className="text-[12px] text-ink-tertiary" title={utcTitle(u.last_seen)}>{formatLastSeen(u.last_seen)}</span>,
                  },
                ]}
              />
            </div>
          )}
        </QueryState>
      </section>
    </Page>
  );
}
