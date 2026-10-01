import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, GitBranch, Server } from 'lucide-react';
import { api } from '../api';
import { TimelineBar } from '../components/TimelineBar';
import { csvParam } from '../urlParams';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { FilterAccordion, FILTERS_OPEN, parseFiltersOpen } from '../components/FilterAccordion';
import { describeFilters } from '../filterSummary';
import { MetricsTilesRow, MetricsTotals } from '../components/MetricsTilesRow';
import { Badge, Button, ChipRow, DateRange, LocalTime, Page, PeriodControl, QueryState } from '../components/ui';
import { eventTone, itemTypeClass } from '../eventTone';
import { shortRemote } from '../components/facetSearch';
import { eventTypeLabel, mergeEventTypes } from '../eventTypes';
import { eventFields } from '../eventDetails';
import { EventTypeChips } from '../components/EventTypeChips';
import { browserTimezone, endOfLocalDay, startOfLocalDay } from '../dates';
import { useToggleSet } from '../hooks/useToggleSet';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { usePeopleNames } from '../hooks/usePeopleNames';
import { PersonAvatar } from '../components/PersonName';
import { useChildHubs } from '../hooks/useChildHubs';
import { scrollPageToTop } from '../scroll';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

const USER_FILTER_KEYS = ['types', 'projects', 'itemTypes', 'range', 'from', 'to'] as const;
// A custom date range is chosen for one person; a bare visit to the next one
// starts from the remembered preset instead.
const USER_TRANSIENT_KEYS = ['from', 'to'] as const;
const USER_LEGACY_KEYS = {
  types: 'agenfk-hub:user:eventTypes',
  projects: 'agenfk-hub:user:projects',
  itemTypes: 'agenfk-hub:user:itemTypes',
};
const readRange = (v: string | null): RangeKey => (RANGES.some(r => r.key === v) ? v : '30d') as RangeKey;

interface MetricsResponse { bucket: string; series: Array<{ user_key: string; day: string; events_count: number; items_closed: number; validate_passes: number; validate_fails: number; prs_opened: number }> }

interface TimelineRow {
  event_id: string; occurred_at: string; type: string; project_id: string | null; item_id: string | null; item_type: string | null; remote_url: string | null; item_title: string | null; external_id: string | null; user_key: string; reporting_version: string | null; payload: any;
  /** A link to the pull request, for a PR event on a GitHub repo. */
  pr_url?: string | null;
}

/** An expanded event: its fields in words, the raw JSON behind a toggle. */
function EventBody({ e }: { e: TimelineRow }) {
  const [raw, setRaw] = useState(false);
  const fields = eventFields(e);
  return (
    <div className="px-5 pb-3 pt-2 bg-canvas/60 border-t border-border-soft -mt-0.5 space-y-2">
      {fields.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
          {fields.map((f, i) => (
            // By position: labels come from untrusted payload keys and can repeat.
            <Fragment key={i}>
              <dt className="text-ink-tertiary">{f.label}</dt>
              <dd className="text-ink-secondary min-w-0 break-words whitespace-pre-wrap">
                {f.href
                  ? (
                    // The key is the link text; the destination shows on hover.
                    <a href={f.href} title={f.href} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline decoration-dotted hover:decoration-solid">
                      {f.value}<span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  )
                  : f.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      <button
        type="button"
        aria-expanded={raw}
        onClick={() => setRaw(v => !v)}
        className="text-[11px] font-medium text-ink-tertiary hover:text-ink"
      >
        {raw ? 'Hide raw JSON' : 'Show raw JSON'}
      </button>
      {raw && <pre className="text-[11px] font-mono text-ink-secondary whitespace-pre-wrap break-words">{JSON.stringify(e.payload, null, 2)}</pre>}
    </div>
  );
}
interface EventTypesResponse { types: string[] }
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[]; counts?: Record<string, number> }

const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;

/** "Showing latest 200 of 1,059", or "Showing all 1,059" once everything is in. */
function shownLine(loaded: number, total: number | undefined): string {
  if (typeof total !== 'number') return `${loaded.toLocaleString()} shown`;
  return loaded >= total ? `Showing all ${total.toLocaleString()}` : `Showing latest ${loaded.toLocaleString()} of ${total.toLocaleString()}`;
}

/** Events fetched per page of the list. */
const EVENTS_PAGE = 200;
interface TimelinePage { events: TimelineRow[]; total?: number; nextBefore?: string }



export function UserDetailPage() {
  const { userKey = '' } = useParams();
  const decoded = decodeURIComponent(userKey);
  const personName = usePeopleNames()(decoded);

  useEffect(() => { scrollPageToTop(); }, [userKey]);
  // Every filter lives in the URL, so a reload or a shared link shows the same
  // view. A bare visit opens as this browser left it (useUrlFilters).
  const filters = useUrlFilters({ keys: USER_FILTER_KEYS, storageKey: 'agenfk-hub:user:filters', legacy: USER_LEGACY_KEYS, forget: USER_TRANSIENT_KEYS });
  const fp = filters.params;
  // Default to "what did this user ship?" — closures only — until the dev
  // widens the chip selection. `types=` (present, empty) is an explicit "none".
  const eventTypeSel = useToggleSet(fp.has('types') ? csvParam(fp, 'types') : ['item.closed']);
  const projectSel = useToggleSet(csvParam(fp, 'projects'));
  const itemTypeSel = useToggleSet(csvParam(fp, 'itemTypes'));
  // The one URL writer for the chips (see useUrlFilters on why only one).
  const { write: writeFilters } = filters;
  useEffect(() => {
    writeFilters({
      types: [...eventTypeSel.set].join(','),
      projects: projectSel.set.size ? [...projectSel.set].join(',') : null,
      itemTypes: itemTypeSel.set.size ? [...itemTypeSel.set].join(',') : null,
    });
  }, [eventTypeSel.set, projectSel.set, itemTypeSel.set, writeFilters]);
  // The child hub arrives in the link, not from a picker on this page: you got
  // here by clicking a person out of a board that was already scoped, and a
  // person page aggregating them across the whole federation would quietly
  // contradict the board you came from (BUG b0167566). Read-only here — the
  // scope is the caller's, and there is nothing on this page to change it with.
  const [searchParams] = useSearchParams();
  const childHubs = csvParam(searchParams, 'childHubId');
  const hubCsv = childHubs.length ? childHubs.join(',') : null;
  // Named on the page, not merely applied to it. The scope arrives in a link
  // and there is no control here to clear it, so without a label this is the
  // one page in the app that filters invisibly — which is exactly what
  // useChildHubs says must never happen. An id the server does not know still
  // shows, as the raw id: a detached or mistyped hub matches no rows, so every
  // tile reads zero and the event list blames "the current filters" while the
  // Filters panel shows no filter that would explain it.
  const hubLabels = useChildHubs(new Set(childHubs));

  // The period is read straight from the URL; its controls write it there.
  const range = readRange(fp.get('range'));
  const customStart = fp.get('from') ?? '';
  const customEnd = fp.get('to') ?? '';

  const customFromIso = useMemo(() => customStart ? startOfLocalDay(customStart) : '', [customStart]);
  const customToIso = useMemo(() => customEnd ? endOfLocalDay(customEnd) : '', [customEnd]);

  // Partitioned by hub, exactly as Org does it: offering a repo or an event
  // type that belongs to a hub this page is not showing is a dead end.
  const hubQs = hubCsv ? `?${new URLSearchParams({ childHubId: hubCsv })}` : '';
  const eventTypes = useQuery<EventTypesResponse>({
    queryKey: ['event-types', hubQs],
    queryFn: async () => (await api.get(`/v1/event-types${hubQs}`)).data,
  });
  const projects = useQuery<ProjectsResponse>({
    queryKey: ['projects', hubQs],
    queryFn: async () => (await api.get(`/v1/projects${hubQs}`)).data,
  });

  // Per-itemType counts honour the user, project, and event-type filters but
  // ignore the itemTypes filter (the chip answers "what would I see if I
  // selected this", which can't pre-filter by the current selection).
  const itemTypesQs = useMemo(() => {
    const p = new URLSearchParams();
    p.set('users', decoded);
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    if (hubCsv) p.set('childHubId', hubCsv);
    return p.toString();
  }, [decoded, projectSel.set, eventTypeSel.set, hubCsv]);
  const itemTypes = useQuery<ItemTypesResponse>({
    queryKey: ['item-types', itemTypesQs],
    queryFn: async () => (await api.get(`/v1/item-types?${itemTypesQs}`)).data,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('users', decoded);
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    if (hubCsv) p.set('childHubId', hubCsv);
    if (customFromIso) p.set('from', customFromIso);
    else p.set('from', fromIsoForRange(new Date(), range));
    if (customToIso) p.set('to', customToIso);
    return p;
  }, [decoded, eventTypeSel.set, projectSel.set, itemTypeSel.set, range, customFromIso, customToIso, hubCsv]);

  const metricsQs = useMemo(() => {
    const p = new URLSearchParams();
    p.set('users', decoded);
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    if (hubCsv) p.set('childHubId', hubCsv);
    if (customFromIso) p.set('from', customFromIso);
    else p.set('from', fromIsoForRange(new Date(), range));
    if (customToIso) p.set('to', customToIso);
    return p.toString();
  }, [decoded, projectSel.set, itemTypeSel.set, range, customFromIso, customToIso, hubCsv]);

  const metrics = useQuery<MetricsResponse>({
    queryKey: ['metrics', metricsQs],
    queryFn: async () => (await api.get(`/v1/metrics?${metricsQs}`)).data,
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

  // Pages of the newest events, newest first; Load more fetches the next page.
  // The server says how many match in all, so the list never stops silently.
  const tlPages = useInfiniteQuery<TimelinePage, Error, { pages: TimelinePage[] }, unknown[], string | null>({
    // hubCsv belongs in the KEY, not just the request: without it two hubs
    // share one cache entry and this page paints the other hub's events until a
    // background refetch lands — or forever, if that refetch errors.
    queryKey: ['timeline', userKey, [...eventTypeSel.set].sort().join(','), [...projectSel.set].sort().join(','), [...itemTypeSel.set].sort().join(','), range, customFromIso, customToIso, hubCsv ?? ''],
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('limit', String(EVENTS_PAGE));
      // A cursor from the last event shown, not an offset: events arriving in
      // between cannot shift a shown one onto the next page.
      if (pageParam) p.set('before', pageParam);
      return (await api.get(`/v1/timeline?${p}`)).data;
    },
    getNextPageParam: (last, pages) => {
      // A full last page always carries a cursor; stop once everything the
      // first page counted is in, or Load more would fetch nothing.
      const loaded = pages.reduce((n, pg) => n + pg.events.length, 0);
      const total = pages[0].total;
      if (typeof total === 'number' && loaded >= total) return undefined;
      return last.nextBefore ?? undefined;
    },
    // The app refreshes every 30s. Once more than one page is loaded that would
    // re-request every page in turn, so the list holds still until it is reset.
    refetchInterval: query => ((query.state.data?.pages.length ?? 1) > 1 ? false : 30_000),
  });
  const tl = {
    data: tlPages.data
      ? {
        // De-duplicated by id as well, so an overlap can never show a row twice
        // or reuse a React key.
        events: [...new Map(tlPages.data.pages.flatMap(pg => pg.events).map(e => [e.event_id, e])).values()],
        // The count comes with the first page only.
        total: tlPages.data.pages[0].total,
      }
      : undefined,
    isError: tlPages.isError,
    error: tlPages.error,
    isFetching: tlPages.isFetching,
    refetch: tlPages.refetch,
  };

  const types = mergeEventTypes(eventTypes.data?.types);
  const projectOptions = projects.data?.projects ?? [];
  const itemTypeOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_ITEM_TYPES);
    for (const t of itemTypes.data?.itemTypes ?? []) set.add(t);
    return [...set].sort();
  }, [itemTypes.data]);

  return (
    <Page>
      {/* Carries the scope back. Org's hub facet is URL-persisted and
          deliberately not stored, so without this the trip out and back
          silently widens to every hub — the same drop, in the other direction. */}
      <Link to={`/${hubCsv ? `?${new URLSearchParams({ childHubId: hubCsv })}` : ''}`}
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-tertiary hover:text-accent-ink">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to org
      </Link>

      <header className="flex items-center gap-4">
        <PersonAvatar name={personName} userKey={decoded} size="lg" />
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-accent-ink font-semibold">User</p>
          {personName ? (
            <>
              <h1 className="mt-0.5 text-xl font-bold tracking-tight text-ink truncate">{personName}</h1>
              <p className="font-mono text-[12px] text-ink-tertiary truncate">{decoded}</p>
            </>
          ) : (
            <h1 className="mt-0.5 text-xl font-bold tracking-tight font-mono text-ink truncate">{decoded}</h1>
          )}
          {childHubs.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-tertiary">
              <Server className="w-3 h-3" />
              <span>Scoped to</span>
              {childHubs.map(id => (
                <span key={id}
                  className="inline-flex items-center rounded-full bg-surface-raised px-2 py-0.5 font-medium text-ink-secondary">
                  {hubLabels.label(id)}
                </span>
              ))}
            </p>
          )}
        </div>
      </header>

      <QueryState query={metrics} label="activity totals">{() => <MetricsTilesRow totals={totals} selectedTypes={eventTypeSel.set} onFilterTypes={eventTypeSel.replace} />}</QueryState>

      {/* The period is always in view; the facets fold behind one summary line. */}
      <PeriodControl
        ranges={RANGES}
        active={!customFromIso && !customToIso ? range : null}
        onPick={key => filters.write({ range: key, from: null, to: null })}
      >
        <DateRange
          from={customStart}
          to={customEnd}
          onChange={(from, to) => filters.write({ from: from || null, to: to || null })}
        />
      </PeriodControl>

      <FilterAccordion
        activeCount={[projectSel.set, itemTypeSel.set].filter(x => x.size > 0).length}
        summary={describeFilters({
          range,
          from: customStart,
          to: customEnd,
          types: [...eventTypeSel.set],
          projects: [...projectSel.set].map(shortRemote),
          itemTypes: [...itemTypeSel.set],
        })}
        open={parseFiltersOpen(searchParams.get(FILTERS_OPEN))}
        onOpenChange={open => filters.write({ [FILTERS_OPEN]: open ? '1' : null })}
      >
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
        users={[decoded]}
        types={[...eventTypeSel.set]}
        projects={[...projectSel.set]}
        itemTypes={[...itemTypeSel.set]}
        childHubs={childHubs}
        title="Activity timeline"
        range={range}
        onRangeChange={r => filters.write({ range: r, from: null, to: null })}
        fromIsoOverride={customFromIso || undefined}
        toIsoOverride={customToIso || undefined}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-secondary">Recent events</h2>
          <span className="text-[11px] text-ink-tertiary" title={`All times in ${browserTimezone()}`}>{tl.data && tl.data.events.length > 0 && `${shownLine(tl.data.events.length, tl.data.total)} · `}times in {browserTimezone()}</span>
        </div>
        <QueryState
          query={tl}
          label="events"
          isEmpty={data => data.events.length === 0}
          empty={<div className="bg-card-glass border border-border-soft rounded-2xl px-5 py-8 text-center text-sm text-ink-tertiary">No events match the current filters.</div>}
        >
          {data => (
            <div className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl divide-y divide-border-soft overflow-hidden">
              {data.events.map(e => {
                return (
                  <details key={e.event_id} className="group">
                    <summary className="flex items-center gap-3 px-5 py-2.5 cursor-pointer list-none hover:bg-canvas transition-colors">
                      <ChevronDown className="w-3.5 h-3.5 text-ink-tertiary group-open:rotate-180 transition-transform shrink-0" />
                      <Badge tone={eventTone(e.type)} className="text-[10px] font-medium" title={e.type}>{eventTypeLabel(e.type)}</Badge>
                      {e.item_type && <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border ${itemTypeClass(e.item_type)}`}>{e.item_type}</span>}
                      {e.external_id && (
                        <span title={`External tracker: ${e.external_id}`} className="px-2 py-0.5 rounded-md text-[10px] font-mono border border-transparent bg-accent-fill text-accent-ink">
                          {e.external_id}
                        </span>
                      )}
                      {e.remote_url && (
                        <span title={e.remote_url} className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono bg-canvas text-ink-tertiary border border-border-soft max-w-[180px] truncate">
                          <GitBranch className="w-2.5 h-2.5 shrink-0" /> {shortRemote(e.remote_url)}
                        </span>
                      )}
                      <span className="text-[12px] text-ink truncate flex-1" title={e.item_id ?? undefined}>
                        {e.item_title ?? <span className="text-ink-tertiary font-mono">{e.item_id ?? e.project_id ?? '—'}</span>}
                      </span>
                      {e.reporting_version && (
                        <span
                          title={`Emitted by AgenFK ${e.reporting_version} (X-Agenfk-Version header)`}
                          className="hidden md:inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-mono bg-canvas text-ink-tertiary border border-border-soft shrink-0"
                        >
                          v{e.reporting_version}
                        </span>
                      )}
                      <LocalTime value={e.occurred_at} className="text-[11px] text-ink-tertiary tabular-nums shrink-0" />
                    </summary>
                    <EventBody e={e} />
                  </details>
                );
              })}
            </div>
          )}
        </QueryState>
        {tlPages.hasNextPage && (
          <div className="flex justify-center">
            <Button size="sm" onClick={() => { void tlPages.fetchNextPage(); }} disabled={tlPages.isFetchingNextPage}>
              {tlPages.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </section>
    </Page>
  );
}
