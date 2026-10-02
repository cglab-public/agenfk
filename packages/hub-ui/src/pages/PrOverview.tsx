import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { GitPullRequest, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { FilterAccordion, parseFiltersOpen } from '../components/FilterAccordion';
import { ModelMetaFilter } from '../components/ModelMetaFilter';
import { shortRemote } from '../components/facetSearch';
import { useToggleSet } from '../hooks/useToggleSet';
import { useChildHubs } from '../hooks/useChildHubs';
import { csvParam } from '../urlParams';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useSettledKey } from '../hooks/useSettledKey';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';
import { SIZE_META, type SizeKey, buildDayAxis, pctDelta } from '../prOverview';
import { heatColor } from '../chartColours';
import { Sparkline, sharedPeak } from '../components/Sparkline';
import { parsePrQuery } from '../prSearch';
import { buildMonthBands, dayHeaderInfo, contributionPcts, cellTooltip, placeTooltip } from '../prPerDay';
import { buildVolumeSeries, edgeCoverage, type Granularity } from '../prVolumeGranularity';
import { PrVolumeChart } from '../components/PrVolumeChart';
import { DataTable, DateRange, LocalTime, Page, PageHeader, PeriodControl, QueryError, Skeleton, StatTile } from '../components/ui';
import { browserTimezone, endOfLocalDay, startOfLocalDay } from '../dates';
import { describeFilters } from '../filterSummary';
import { usePeopleNames } from '../hooks/usePeopleNames';
import { PersonName, PersonAvatar } from '../components/PersonName';

const GRANULARITIES: Array<{ key: Granularity; label: string; unit: string }> = [
  { key: 'daily', label: 'daily', unit: 'day' },
  { key: 'weekly', label: 'weekly', unit: 'week' },
  { key: 'monthly', label: 'monthly', unit: 'month' },
];

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

type SizeDist = Record<SizeKey, number>;
interface PrOverviewResponse {
  period: { from: string | null; to: string | null };
  buckets: SizeKey[];
  totals: { prs: number; sizePoints: number; developers: number; medianBucket: SizeKey | null };
  resized: { count: number; grew: number; shrank: number };
  byDay: Array<{
    day: string;
    sizes: SizeDist;
    total: number;
    devBySize: Record<SizeKey, Array<{ user_key: string; count: number }>>;
  }>;
  byDeveloper: Array<{ user_key: string; prs: number; sizePoints: number; sizes: SizeDist; daily: Record<string, number> }>;
  byModel: Array<{ model: string; harnesses: string[]; prs: number; sizePoints: number; sizes: SizeDist }>;
  // CGLAB-131 drill-down: the resolved PR set behind the heatmap cells
  // (opener attribution, latest sizing — same aggregation pass as the totals).
  prs: Array<{
    repo: string;
    prNumber: number;
    /**
     * CGLAB-184: which hub reported it — a child hub's id, or 'local' for this
     * hub's own. On a parent hub (repo, prNumber) is NOT unique: two children
     * can each size acme/web#57, and they are different PRs on different
     * forges. Optional so a response from an older hub still types.
     */
    childHubId?: string;
    url: string | null;
    user_key: string;
    model: string;
    harness: string | null;
    openedAt: string;
    day: string;
    points: number;
    bucket: SizeKey;
  }>;
  previous: { prs: number; sizePoints: number } | null;
}
interface ProjectsResponse { projects: string[] }

/** The heatmap's focus ring, on whichever element is a cell's focus target. */
const HEAT_FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * A stable identity for one PR row.
 *
 * Deliberately NOT `repo#number`: on a parent hub that pair collides across
 * child hubs, and a duplicate React key makes reconciliation reuse one node for
 * two rows — so a filter change can leave the wrong opener and size on screen.
 * Falls back to 'local' for a response from a hub that predates the field.
 */
const prKey = (p: { repo: string; prNumber: number; childHubId?: string }) =>
  `${p.childHubId ?? 'local'}\u0000${p.repo}#${p.prNumber}`;

// XL→XS so the stacked bar renders largest at the bottom. Hoisted out of render.
const colorOf = (k: SizeKey) => SIZE_META.find(s => s.key === k)!.color;

/** Horizontal stacked size-mix bar for one row of size counts. */
export function MixBar({ sizes, total }: { sizes: SizeDist; total: number }) {
  // The segments are empty spans: the counts go in the bar's own name, not in
  // a per-segment title that only a mouse can read.
  const present = SIZE_META.filter(s => sizes[s.key] > 0);
  const label = `Size mix: ${total === 0 ? 'no PRs' : present.map(s => `${s.label} ${sizes[s.key]}`).join(', ')}`;
  if (total === 0) return <div role="img" aria-label={label} className="h-2 w-full rounded-full bg-border-soft" />;
  return (
    // 2px gaps keep neighbouring ramp steps apart; the track is neutral.
    <div role="img" aria-label={label} className="flex gap-[2px] h-2 w-full rounded-full overflow-hidden bg-border-soft">
      {present.map(s => (
        <span key={s.key} title={`${s.label}: ${sizes[s.key]}`} style={{ background: s.color, width: `${(sizes[s.key] / total) * 100}%` }} />
      ))}
    </div>
  );
}

function SizeCounts({ sizes }: { sizes: SizeDist }) {
  return (
    <div className="flex gap-1">
      {SIZE_META.map(s => (
        <span
          key={s.key}
          title={`${s.label} PRs`}
          className={`min-w-[26px] text-center rounded-md px-1 py-0.5 font-mono text-caption tabular-nums ${sizes[s.key] === 0
            ? 'text-ink-tertiary bg-canvas'
            : 'text-ink-secondary bg-canvas'}`}
        >
          {sizes[s.key]}
        </span>
      ))}
    </div>
  );
}

/** CGLAB-131 — the per-cell drill-down: the PRs one developer opened on one
 *  day, with a GitHub link where the server could derive one. Rendered at the
 *  page root (fixed positioning — same containing-block rule as the tooltip).
 *  Focus management (aria-modal contract): focus moves into the dialog on
 *  open and Tab cycles inside it; focus returns to the triggering cell on
 *  close; background scrolling is locked while open. */
function PrDrilldownModal({ dev, day, prs, onClose }: {
  dev: string;
  day: string;
  prs: NonNullable<PrOverviewResponse['prs']>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Initial focus + focus restore (runs once per open).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { prev?.focus?.(); };
  }, []);

  // Escape to close (window-level: works no matter where focus sits inside).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scroll lock while the overlay is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Minimal focus trap: wrap Tab / Shift+Tab at the dialog edges.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus();
    }
  };

  const { weekday } = dayHeaderInfo(day);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`PRs by ${dev} on ${day}`} onKeyDown={trapTab}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div ref={panelRef} className="relative z-50 w-full max-w-form max-h-[70vh] overflow-y-auto rounded-2xl border border-border-soft bg-surface shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border-soft bg-surface px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="truncate text-body font-semibold text-ink">{dev}</h3>
            <p className="font-mono text-caption text-ink-tertiary">{weekday} {day} · {prs.length} PR{prs.length === 1 ? '' : 's'}</p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-border-soft px-2 py-1 text-small text-ink-tertiary hover:text-ink hover:bg-accent-fill transition-colors"
          >
            ✕
          </button>
        </div>
        <ul className="divide-y divide-border-soft">
          {prs.map(p => {
            const size = SIZE_META.find(s => s.key === p.bucket);
            const openedAt = new Date(p.openedAt);
            const rowBody = (
              <>
                {p.url ? (
                  <span className="font-mono text-body font-bold text-accent-ink shrink-0">
                    #{p.prNumber}
                  </span>
                ) : (
                  <>
                    <span
                      className="font-mono text-body font-bold text-ink-secondary shrink-0"
                      title={`${p.repo} — no GitHub link (non-GitHub host)`}
                    >
                      #{p.prNumber}
                    </span>
                    {/* Why this row is not a link, read out rather than hover-only. */}
                    <span className="sr-only">no GitHub link (non-GitHub host)</span>
                  </>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-small text-ink-secondary">{p.repo}</div>
                  <div className="text-caption text-ink-tertiary truncate">{p.model}{p.harness ? ` · via ${p.harness}` : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  {size && (
                    // size.text (not a fixed text-white): the ramp's light end
                    // is near-white, so white-on-XS reads as a blank box.
                    <span className="inline-block rounded-md px-1.5 py-0.5 font-mono text-caption font-bold" style={{ background: size.color, color: size.text }}>
                      {size.label}
                    </span>
                  )}
                  <div className="mt-0.5 font-mono text-caption text-ink-tertiary tabular-nums">
                    {!Number.isNaN(openedAt.getTime()) && <LocalTime value={openedAt} />}
                  </div>
                </div>
              </>
            );
            // Whole row is the GitHub link (no nested anchors): the <a> IS the
            // row container, so repo / model / badge / time all open the PR.
            // Rows without a derived link stay inert.
            return p.url ? (
              <li key={prKey(p)}>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open on GitHub"
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-accent-fill/40 transition-colors"
                >
                  {rowBody}
                </a>
              </li>
            ) : (
              <li key={prKey(p)} className="flex items-center gap-3 px-5 py-2.5">
                {rowBody}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function PrOverviewPage() {
  // The URL query string is the source of truth for every filter, so a refresh
  // or a shared link restores the exact same view. State is seeded from the URL
  // on first render and written back (replace) whenever a filter changes.
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const csv = (k: string) => csvParam(searchParams, k);
  const readRange = (sp: URLSearchParams): RangeKey => {
    const v = sp.get('range');
    return (RANGES.some(r => r.key === v) ? v : '30d') as RangeKey;
  };
  const readGran = (sp: URLSearchParams): Granularity => {
    const v = sp.get('gran');
    return v === 'weekly' || v === 'monthly' ? v : 'daily';
  };
  // Repeated ?pr= params seed from the first entry that PARSES, mirroring the
  // server's parsePrNumberFilter — see the prQuery state below for why.
  const readPrQuery = (sp: URLSearchParams): string =>
    [...sp.getAll('pr')].find(v => parsePrQuery(v) !== null) ?? '';
  const initRange = readRange(searchParams);

  const projectSel = useToggleSet(csv('projects'));
  const devSel = useToggleSet(csv('developers'));
  const modelSel = useToggleSet(csv('model'));
  const childHubSel = useToggleSet(csv('childHubId'));
  const childHubs = useChildHubs(childHubSel.set);
  const [range, setRange] = useState<RangeKey>(initRange);
  const [gran, setGran] = useState<Granularity>(() => readGran(searchParams));
  // Explicit date range (YYYY-MM-DD); when set it overrides the preset range.
  const [customFrom, setCustomFrom] = useState<string>(searchParams.get('from') ?? '');
  const [customTo, setCustomTo] = useState<string>(searchParams.get('to') ?? '');
  // Accordion open/closed lives in the URL like every other filter, so a shared
  // or bookmarked link restores the same layout. Absent param = open.
  const [filtersOpen, setFiltersOpen] = useState(() => parseFiltersOpen(searchParams.get('filters')));
  // PR-number search. The raw text is kept (so "#" and a half-typed box survive
  // the keystroke that produced them) and parsed on every render; only the
  // parsed number reaches the URL and the API, which is why a shared link says
  // ?pr=57 however the user spelled it in the box.
  //
  // Repeated ?pr= params seed from the first entry that PARSES, mirroring the
  // server's parsePrNumberFilter. searchParams.get returns the FIRST entry
  // whatever it holds, so `?pr=&pr=57` would open the windowed overview and then
  // the URL effect below would rewrite the address bar without `pr` at all —
  // deleting the link's own evidence that it asked for PR #57.
  const [prQuery, setPrQuery] = useState<string>(() => readPrQuery(searchParams));
  const prNumber = parsePrQuery(prQuery);
  // A PR search supersedes the date window, the model filter and the developer
  // filter. Project (git remote) is the one filter it respects — a PR number is
  // unique per repo, not per org.
  const searchActive = prNumber !== null;
  // The request waits for a pause in typing; the box, the URL and the disabled
  // controls do not. Without this, entering `1234` commits four query keys and
  // fires four searches — and a PR search reads the org's whole PR event stream
  // with no time bound (see routes/queries.ts), so four keystrokes is four full
  // scans to answer one question. Cold load is unaffected: the hook starts
  // settled, so a shared ?pr=57 link is not one tick slower.
  //
  // A navigation is not typing. `navPr` is the PR number most recently
  // delivered BY a navigation; while the box still holds it the debounce is
  // bypassed, so a Back onto ?pr=57 does not spend 350ms with the box saying 57
  // and the URL write-back publishing an address bar with no `pr` in it — which
  // became permanent if the reader navigated again inside that window.
  const [navPr, setNavPr] = useState<number | null>(() => parsePrQuery(readPrQuery(searchParams)));
  const queryPrNumber = useDebouncedValue(prNumber, 350, navPr);

  // Follow the URL, the way the chip facets already do (BUG 8e40e463).
  //
  // These six controls are plain state mirrored INTO the query string, so they
  // were not merely stale on a navigation: react-router hands back a fresh
  // setSearchParams on every location change, which re-runs the write-back
  // effect below and rewrites the whole query string from mount-time state.
  // The incoming values were deleted, not ignored.
  //
  // The discriminator is "did WE write this?", not the navigation type. A
  // value-keyed follow cannot work, because the write-back omits a control at
  // its default (no `range` when it is 30d, no `range` at all while an explicit
  // from/to is set) — so "absent from the URL" does not mean "default", and a
  // naive follow would reset the range every time a custom date range is used.
  // And keying on POP alone left every PUSH broken: clicking the sidebar's own
  // "PR overview" link while already on a filtered /prs cleared the chips,
  // kept the range, and rewrote the bare /prs you asked for.
  const location = useLocation();
  const lastWritten = useRef<string | null>(null);
  useEffect(() => {
    const incoming = location.search.replace(/^\?/, '');
    if (lastWritten.current === incoming) return; // our own write-back
    const sp = new URLSearchParams(incoming);
    setRange(readRange(sp));
    setGran(readGran(sp));
    setCustomFrom(sp.get('from') ?? '');
    setCustomTo(sp.get('to') ?? '');
    setFiltersOpen(parseFiltersOpen(sp.get('filters')));
    const pr = readPrQuery(sp);
    setPrQuery(pr);
    setNavPr(parsePrQuery(pr));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.search]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (devSel.set.size) p.set('developers', [...devSel.set].join(','));
    if (modelSel.set.size) p.set('model', [...modelSel.set].join(','));
    // Same spelling the server reads, so a shared link needs no translation.
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    if (customFrom || customTo) {
      // Explicit range takes precedence over the preset in the URL too.
      if (customFrom) p.set('from', customFrom);
      if (customTo) p.set('to', customTo);
    } else if (range !== '30d') {
      p.set('range', range); // omit the default to keep the URL clean
    }
    if (gran !== 'daily') p.set('gran', gran); // volume-chart granularity (default omitted)
    // The parsed number, not the raw box text — links stay short and a pasted URL
    // does not end up in the address bar of everyone you share with.
    //
    // `queryPrNumber`, i.e. the number the request will actually make. Writing the
    // immediate value meant typing "57" put `?pr=5` in the address bar for a
    // moment: anyone who copied the link, or reloaded, mid-typing got PR #5. The
    // box still follows the keyboard; the committed query is what the URL holds.
    if (queryPrNumber !== null) p.set('pr', String(queryPrNumber));
    // Only the non-default (open) state is written, so the common URL stays clean.
    if (filtersOpen) p.set('filters', '1');
    // Remembered so the follow-the-URL effect above can tell our own write from
    // somebody else's navigation.
    lastWritten.current = p.toString();
    // navigate rather than setSearchParams: the latter resolves to a bare
    // "?query", which drops any fragment the URL arrived with.
    navigate({ search: p.toString() ? `?${p}` : '', hash: location.hash }, { replace: true });
  }, [projectSel.set, devSel.set, modelSel.set, childHubSel.set, range, gran, customFrom, customTo, filtersOpen, queryPrNumber, navigate, location.hash]);

  // A custom range is the viewer's LOCAL days, like the presets and the user page.
  // A malformed date in a shared link is no bound, not a crash.
  const from = useMemo(
    () => startOfLocalDay(customFrom) || fromIsoForRange(new Date(), range),
    [customFrom, range],
  );
  // Inclusive end-of-day so a PR opened any time on `customTo` is counted.
  const toParam = endOfLocalDay(customTo);
  // The viewer's IANA zone, so the server files each PR under the local day it
  // was opened and the axis below matches it, by each date's own offset.
  const timeZone = browserTimezone();

  // Shared filters (project + date window). Model and developer are NOT here —
  // they're applied only to the data query, so the options query can list the
  // full set of models/developers available in the window.
  const baseQs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    // Sits with `projects`, not with model/developer: the hub partitions the
    // data rather than narrowing a view of it, so the options query must be
    // partitioned too — otherwise the model and developer lists offer names
    // from hubs the board is not showing.
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    p.set('from', from);
    if (toParam) p.set('to', toParam);
    // The zone, and the offset as the fallback for a server whose ICU lacks it.
    // A browser that cannot name its zone sends neither: the axis then uses
    // UTC days, and so must the server.
    if (timeZone) {
      p.set('tz', timeZone);
      p.set('tzOffsetMin', String(-new Date().getTimezoneOffset()));
    }
    return p;
  }, [projectSel.set, childHubSel.set, from, toParam, timeZone]);

  const dataQs = useMemo(() => {
    // Search mode: projects + the number, and nothing else. The superseded
    // filters are dropped from the request rather than sent alongside it, so the
    // server can never disagree with the user about what "PR #57" means — and a
    // stale ?model= left in the URL from before the search cannot quietly narrow
    // the answer to zero rows.
    //
    // `queryPrNumber`, not `prNumber`: this is the one consumer that should lag
    // the keyboard (see useDebouncedValue).
    if (queryPrNumber !== null) {
      const p = new URLSearchParams();
      if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
      // Kept through a PR search, like `projects` and for the same reason: #57
      // exists in every repo AND on every hub, so dropping this would make one
      // search return two unrelated PRs that merely share a number.
      if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
      p.set('pr', String(queryPrNumber));
      // The zone stays: a searched PR is filed under its local day too.
      if (timeZone) {
        p.set('tz', timeZone);
        p.set('tzOffsetMin', String(-new Date().getTimezoneOffset()));
      }
      return p.toString();
    }
    const p = new URLSearchParams(baseQs);
    if (modelSel.set.size) p.set('model', [...modelSel.set].join(','));
    if (devSel.set.size) p.set('users', [...devSel.set].join(','));
    return p.toString();
  }, [baseQs, modelSel.set, devSel.set, projectSel.set, childHubSel.set, queryPrNumber, timeZone]);

  const overview = useQuery<PrOverviewResponse>({
    queryKey: ['pr-overview', dataQs],
    queryFn: async () => (await api.get(`/v1/prs/overview?${dataQs}`)).data,
    // Keep the previous answer on screen while the next one loads. Without it
    // every committed key change makes `data` undefined, which unmounts the whole
    // results tree (KPIs, charts, heatmap) behind "Loading…" — and closes any
    // open drill-down, whose effect resets on `[d]`. A keystroke should not
    // blank the page.
    placeholderData: keepPreviousData,
  });

  /**
   * Which query the ROWS on screen were actually asked for. `dataQs` names the
   * REQUEST; because of `keepPreviousData` the answer being rendered can still
   * belong to the previous one, and for a PR search that gap is seconds rather
   * than a blink (the scan is deliberately unbounded). So every claim about the
   * data — "Showing PR #57 only", "No PR #57 found", and above all whether this
   * data may be used as a facet universe — is pinned here rather than to the key
   * currently in flight.
   */
  const settledQs = useSettledKey(dataQs, overview.isPlaceholderData);
  const settledParams = useMemo(() => new URLSearchParams(settledQs), [settledQs]);
  // What the rendered rows really are: a PR search's answer, or a window's.
  const dataIsSearch = settledParams.has('pr');
  const answeredPrNumber = Number(settledParams.get('pr') ?? '0');
  // True only while the rows on screen are the rows the copy says they are:
  // the box has settled (debounce elapsed) AND the answer for that key has
  // arrived. Until then the page is showing the previous result.
  const answerMatchesBox =
    !overview.isPlaceholderData && settledQs === dataQs && queryPrNumber === prNumber;

  // Model + developer dropdown options come from the overview UNFILTERED by
  // model/developer (same project + window). When neither filter is active the
  // main `overview` already holds the full lists, so the extra request only runs
  // once a model or developer is selected — or while a PR search is on.
  //
  // The search case is not waste and was a bug: under a search the main overview
  // is the ANSWER, not the option universe. A miss returns empty lists and a hit
  // returns one developer, so sourcing the facets from it makes the Developer and
  // Model controls disappear — the opposite of the agreed "disabled and greyed,
  // not hidden", and it leaves a live selection in the URL with nothing on screen
  // to show or clear it. Keep feeding them the unfiltered lists.
  const filtersActive = !searchActive && (modelSel.set.size > 0 || devSel.set.size > 0);
  const optionsQuery = useQuery<PrOverviewResponse>({
    queryKey: ['pr-overview-opts', baseQs.toString()],
    queryFn: async () => (await api.get(`/v1/prs/overview?${baseQs.toString()}`)).data,
    enabled: filtersActive || searchActive,
    placeholderData: prev => prev, // keep prior options during refetch — don't blank the facet
  });
  /**
   * The option UNIVERSE behind the Developer/Model facets — never a search ANSWER.
   * A miss contains no developers and no models and a hit contains exactly one of
   * each, so sourcing the facets from an answer either hides the control (the bug
   * this replaces) or offers a value the selected window does not contain, which
   * the user can then pick to produce a zero-row overview.
   *
   * Two sources qualify. The unfiltered options query always does. The main
   * overview does while it is neither a search answer nor narrowed by these same
   * facets — and note that is a statement about the DATA, not about the box: the
   * moment a search is typed its rows are still the window's and unfiltered, so
   * the lists it carries are already the full ones. That is what keeps the facets
   * populated and greyed through the search's own debounce and scan instead of
   * blinking them out until the options request lands. `dataIsSearch` is the part
   * that is easy to miss the other way: the instant the box is cleared
   * `searchActive` is false while the rows on screen are STILL the search's answer.
   */
  const mainIsUniverse = !dataIsSearch && !filtersActive;
  const universe = optionsQuery.data ?? (mainIsUniverse ? overview.data : undefined);
  const modelOptions = universe?.byModel.map(m => m.model) ?? [];
  const devOptions = universe?.byDeveloper.map(x => x.user_key) ?? [];
  const nameOf = usePeopleNames();
  // A person's name where a label has room for one thing; the key is added
  // when two keys share a name (one person, two machines without a git email),
  // or the two would be indistinguishable.
  // Counted once per answer, not per call: the heatmap asks for a label twice
  // per cell and re-renders on every hover.
  const sharedNames = useMemo(() => {
    const count = new Map<string, number>();
    for (const k of new Set([...devOptions, ...(overview.data?.byDeveloper ?? []).map(x => x.user_key)])) {
      const n = nameOf(k);
      if (n) count.set(n, (count.get(n) ?? 0) + 1);
    }
    return count;
    // devOptions is derived from `universe` each render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devOptions.join('\u0000'), overview.data, nameOf]);
  const labelOf = (key: string): string => {
    const name = nameOf(key);
    if (!name) return key;
    return (sharedNames.get(name) ?? 0) > 1 ? `${name} (${key})` : name;
  };
  // Partitioned by hub, like the model and developer lists: a repo chip from a
  // hub the board is not showing is a dead end.
  const hubQs = childHubSel.set.size
    ? `?${new URLSearchParams({ childHubId: [...childHubSel.set].join(',') })}`
    : '';
  const projects = useQuery<ProjectsResponse>({
    queryKey: ['projects', hubQs],
    queryFn: async () => (await api.get(`/v1/projects${hubQs}`)).data,
  });

  // Picking a preset clears any explicit date range so the two don't fight.
  const pickRange = (r: RangeKey) => { setRange(r); setCustomFrom(''); setCustomTo(''); };

  const d = overview.data;
  // The windowed end of the axis. A search answer's `period` is the span of the
  // PRs it matched, NOT the selected window, so it must never size a windowed
  // axis: after clearing a search the rows are still that answer, its `to` is the
  // PR's own open date, and `buildDayAxis` returns [] whenever `from` lands after
  // it — an empty heatmap and volume chart under a "Total PRs 1" tile.
  const to = (!dataIsSearch ? d?.period.to : undefined) ?? (toParam || new Date().toISOString());
  // Under a PR search the day axis is the days the matched PRs actually appear
  // on, NOT a contiguous range. Two reasons, both load-bearing:
  //  - the selected range is superseded, so it may well exclude the PR entirely;
  //  - with no Project selected, one number matches a PR per repo, and those PRs
  //    can be months or years apart. A contiguous axis over that span runs into
  //    buildDayAxis's 366-column cap, and every day past the cap vanishes from
  //    the volume chart and the heatmap — the KPI tile would count 2 PRs while
  //    the chart drew 1, and the dropped PR would have no cell to drill into.
  // An axis built from the data cannot truncate, because it is the data.
  //
  // It is also deliberately UNBOUNDED, which is a product decision rather than an
  // oversight: the axis is as long as the matched PRs really span, so a PR open
  // for three years renders ~1000 heatmap columns. The alternative — capping it —
  // reintroduces exactly the failure this replaced, where the KPI tile counts a PR
  // the chart cannot show and that PR has no cell to drill into. A long search is
  // allowed to look long instead of being quietly wrong.
  const searchDays = useMemo(
    () => (searchActive && d ? [...new Set(d.byDay.map(x => x.day))].sort() : []),
    [searchActive, d],
  );
  const axis = useMemo(
    () => (d ? (searchActive ? searchDays : buildDayAxis(from, to, timeZone ?? 'UTC')) : []),
    [d, searchActive, searchDays, from, to, timeZone],
  );
  // Re-bucketed PR volume for the "PR volume by size" chart (daily/weekly/monthly).
  // A PR search's axis is its matched days, whole; otherwise the period's
  // first and last day are partial for a rolling range.
  const volume = useMemo(
    () => (d ? buildVolumeSeries(d.byDay, axis, gran, searchActive ? null : edgeCoverage(from, to, timeZone ?? 'UTC')) : null),
    [d, axis, gran, searchActive, from, to, timeZone],
  );
  const prsDelta = d?.previous ? pctDelta(d.totals.prs, d.previous.prs) : null;
  // The API sends the previous period's size points too (story 4e45bf2f).
  const sizeDelta = d?.previous ? pctDelta(d.totals.sizePoints, d.previous.sizePoints) : null;
  // One scale for every developer's trend line, so rows compare (story 4e45bf2f).
  const trendPeak = useMemo(() => sharedPeak(d?.byDeveloper ?? [], dev => dev.daily, axis), [d, axis]);
  // Reference date for the heatmap's "today" column highlight (local, like the axis).
  const todayIso = buildDayAxis(new Date().toISOString(), new Date().toISOString(), timeZone ?? 'UTC')[0];
  // Per-column header info, computed once per axis instead of per cell.
  const dayInfos = useMemo(() => axis.map(day => dayHeaderInfo(day, todayIso)), [axis, todayIso]);
  // One shared, fixed-position tooltip for the whole heatmap: per-cell hidden
  // spans would add tens of thousands of DOM nodes on a 90d × many-devs grid,
  // and anything positioned inside the overflow-x-auto scroller gets clipped
  // at its edges. Fixed positioning escapes the scroller — BUT only when the
  // tooltip is NOT a descendant of a backdrop-filter/transform element (those
  // create a containing block that silently re-roots the fixed coordinates and
  // a stacking context that swallows the z-index — the CGLAB-131 defect). So it
  // renders at the page root, below, in viewport coordinates from placeTooltip.
  const [heatTip, setHeatTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const heatTipAt = (text: string, el: Element) => {
    const r = el.getBoundingClientRect();
    setHeatTip({ text, ...placeTooltip({ left: r.left, top: r.top, width: r.width, height: r.height }, text, window.innerWidth) });
  };
  const showHeatTip = (text: string) => (e: React.MouseEvent<HTMLDivElement>) => heatTipAt(text, e.currentTarget);

  // The heatmap is an ARIA grid with ONE tab stop (story 6b898739): a stop per
  // non-empty cell was hundreds at 90 days × 20 developers. The stop is the
  // cell last focused, else the first day with PRs; the arrow keys move it.
  const heatGridRef = useRef<HTMLDivElement>(null);
  const [heatPos, setHeatPos] = useState<{ r: number; c: number } | null>(null);
  const heatRows = d?.byDeveloper.length ?? 0;
  const heatCols = axis.length;
  const heatStop = useMemo(() => {
    if (heatPos && heatPos.r < heatRows && heatPos.c < heatCols) return heatPos;
    const devs = d?.byDeveloper ?? [];
    for (let r = 0; r < devs.length; r++) {
      const c = axis.findIndex(day => (devs[r].daily[day] ?? 0) > 0);
      if (c >= 0) return { r, c };
    }
    return { r: 0, c: 0 };
  }, [heatPos, heatRows, heatCols, d, axis]);
  // Whether the last input was a pointer. Focus a click gave (or the drill
  // dialog handed back on closing) opens no tooltip: the pointer is elsewhere
  // by then, and the tip would stay until something else took focus.
  const heatPointer = useRef(false);
  useEffect(() => {
    const pointer = () => { heatPointer.current = true; };
    const key = () => { heatPointer.current = false; };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
    };
  }, []);
  /** The tooltip for a focused cell, measured on the next frame: the browser
   *  scrolls a focused cell into view after the focus event, so measuring in
   *  it placed the tip where the cell had been. */
  const heatTipOnFocus = (text: string, el: HTMLElement) => {
    if (heatPointer.current) return;
    requestAnimationFrame(() => { if (document.activeElement === el) heatTipAt(text, el); });
  };
  const onHeatKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const at = (e.target as HTMLElement).dataset.cell?.split('-').map(Number);
    // Modified keys belong to the browser (Alt+Left is Back, Cmd+Left on a
    // Mac); Ctrl/Cmd+Home/End are the grid's own corner moves.
    const corners = e.key === 'Home' || e.key === 'End';
    if (!at || heatRows === 0 || heatCols === 0 || e.altKey || ((e.metaKey || e.ctrlKey) && !corners)) return;
    // Escape dismisses the tooltip and leaves the focus where it is (WCAG
    // 1.4.13); Space on an empty day would otherwise scroll the page.
    if (e.key === 'Escape') { setHeatTip(null); return; }
    if (e.key === ' ') { e.preventDefault(); return; }
    const [r, c] = at;
    const corner = e.ctrlKey || e.metaKey;
    const next: Record<string, [number, number]> = {
      ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], ArrowUp: [r - 1, c], ArrowDown: [r + 1, c],
      Home: corner ? [0, 0] : [r, 0],
      End: corner ? [heatRows - 1, heatCols - 1] : [r, heatCols - 1],
    };
    const to = next[e.key];
    if (!to) return;
    e.preventDefault();
    const nr = Math.min(heatRows - 1, Math.max(0, to[0]));
    const nc = Math.min(heatCols - 1, Math.max(0, to[1]));
    setHeatPos({ r: nr, c: nc });
    heatGridRef.current?.querySelector<HTMLElement>(`[data-cell="${nr}-${nc}"]`)?.focus();
  };
  // CGLAB-131 — the cell being drilled into (developer × day), or null.
  const [drill, setDrill] = useState<{ dev: string; day: string } | null>(null);
  const closeDrill = useCallback(() => setDrill(null), []);
  const openDrill = useCallback((devKey: string, dayKey: string) => {
    setHeatTip(null);
    setDrill({ dev: devKey, day: dayKey });
  }, []);
  // A refetch replaces the data the open drill was built from — close it
  // rather than show a stale (or emptied) list against the new window.
  // The heatmap's tab stop is a (row, column) of the old answer: on a new one
  // it may name another developer or day, so it goes back to the first day
  // with PRs.
  useEffect(() => { setDrill(null); setHeatPos(null); }, [d]);
  const drillPrs = useMemo(() => {
    if (!drill || !d?.prs) return [];
    // The server already orders by open time, then repo#number, and applied the
    // same window/model/developer filters as the heatmap itself.
    return d.prs.filter(p => p.user_key === drill.dev && p.day === drill.day);
  }, [drill, d?.prs]);

  /**
   * The filters that actually change the answer, as the labels that describe
   * them. Both the badge count and the collapsed-bar summary read this one list,
   * so they cannot drift apart — a facet counted but not listed (or listed but
   * never counted) is exactly how a collapsed bar starts lying about what is
   * live, and until now the two were separate literals that had to be kept in
   * step by hand. Superseded facets are absent while a search is on: they hold a
   * selection that changes nothing.
   */
  const activeFilters = useMemo(() => {
    const out: string[] = [];
    if (searchActive) out.push(`PR #${prNumber}`);
    // Listed even during a PR search, like projects: the hub is not superseded
    // by the search — it still scopes which hub's #57 is being asked about.
    if (childHubSel.set.size) {
      out.push(`${childHubSel.set.size} child hub${childHubSel.set.size === 1 ? '' : 's'}`);
    }
    if (projectSel.set.size) {
      out.push(`${projectSel.set.size} project${projectSel.set.size === 1 ? '' : 's'}`);
    }
    if (!searchActive && devSel.set.size) {
      out.push(`${devSel.set.size} developer${devSel.set.size === 1 ? '' : 's'}`);
    }
    if (!searchActive && modelSel.set.size) {
      out.push(`${modelSel.set.size} model${modelSel.set.size === 1 ? '' : 's'}`);
    }
    return out;
  }, [searchActive, prNumber, childHubSel.set, projectSel.set, devSel.set, modelSel.set]);

  // A PR search replaces the period; everything else it leaves in play is
  // already phrased in activeFilters.
  const filterSummary = searchActive
    ? activeFilters.join(' · ')
    : describeFilters({
      range,
      from: customFrom,
      to: customTo,
      projects: [...projectSel.set].map(shortRemote),
      extra: activeFilters.filter(f => !/project|child hub/.test(f)),
      childHubs: childHubSel.set.size,
    });

  return (
    <Page>
      {/* Hover on the period explains the greyed presets on a shared link: the
          "do not apply" note lives inside the accordion, so with `?filters=0` a
          colleague landing on this page sees disabled controls and no reason. */}
      <PageHeader
        eyebrow="Analytics"
        icon={<GitPullRequest className="w-6 h-6 text-accent-ink" />}
        title="PR Overview"
        subtitle="Pull requests per developer, weighted by size — for the selected period, with a daily breakdown."
        toolbar={(
          <PeriodControl
            ranges={RANGES}
            // From the validated bounds: a malformed date in a link applies the
            // preset, so the preset is what shows as pressed.
            active={!startOfLocalDay(customFrom) && !toParam ? range : null}
            onPick={pickRange}
            // Superseded by a PR search: disabled, not hidden, and the
            // selection survives so clearing the search restores it.
            disabled={searchActive}
            title={searchActive
              ? 'A PR search supersedes the date range — this selection is kept but does not apply until the search is cleared'
              : undefined}
          >
            <DateRange
              from={customFrom}
              to={customTo}
              onChange={(f, t) => { setCustomFrom(f); setCustomTo(t); }}
              disabled={searchActive}
            />
          </PeriodControl>
        )}
      />

      {/* PR search is a filter, but it outranks the facets: it stays in view
          above the collapsed bar rather than inside its fold. */}
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label
            htmlFor="pr-number-search"
            className="eyebrow text-ink-tertiary"
          >
            PR number
          </label>
          {prQuery !== '' && (
            <button
              onClick={() => setPrQuery('')}
              aria-label="Clear PR search"
              className="inline-flex items-center gap-1 text-caption font-medium text-ink-tertiary hover:text-danger-muted"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-focus-ring">
          <Search className="w-3.5 h-3.5 text-ink-tertiary shrink-0" aria-hidden="true" />
          <input
            id="pr-number-search"
            type="text"
            autoComplete="off"
            value={prQuery}
            onChange={e => setPrQuery(e.target.value)}
            placeholder="57, #57, or paste a PR URL…"
            aria-describedby="pr-search-note"
            className="flex-1 min-w-0 bg-transparent outline-none text-small font-mono text-ink placeholder:text-ink-tertiary"
          />
        </div>
        <p id="pr-search-note" className="mt-1.5 text-caption text-ink-tertiary">
          {searchActive ? (
            answerMatchesBox ? (
              <>
                Showing <b className="text-ink-secondary">PR #{prNumber}</b> only — the date, model and
                developer filters do not apply to a PR search. Project (git remote) still does, because
                a PR number is only unique within one repo.
              </>
            ) : (
              /* The rows on screen belong to the previous request (the box has not
                 settled, or the scan is still running — a PR search is deliberately
                 unbounded, so this is seconds). "Showing PR #58 only" over PR #57's
                 table is a wrong statement, not merely a slow one. */
              <>
                Searching for <b className="text-ink-secondary">PR #{prNumber}</b>… the date, model
                and developer filters do not apply to a PR search; the results below are still the
                previous request.
              </>
            )
          ) : (
            'Find one PR by number — accepts 57, #57 or a pasted PR URL. It overrides the date, model'
            + ' and developer filters; Project still applies.'
          )}
        </p>
      </div>

      <FilterAccordion
        activeCount={activeFilters.length}
        summary={filterSummary}
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
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
        options={projects.data?.projects ?? []}
        selected={projectSel.set}
        onToggle={projectSel.toggle}
        onClear={projectSel.clear}
        optionLabel={shortRemote}
        inlineThreshold={6}
        placeholder="Search projects…"
      />

      <FacetMultiselect
        label="Developer"
        options={devOptions}
        optionLabel={labelOf}
        selected={devSel.set}
        onToggle={devSel.toggle}
        onClear={devSel.clear}
        inlineThreshold={6}
        placeholder="Search developers…"
        disabled={searchActive}
      />

      <FacetMultiselect
        label="Model"
        options={modelOptions}
        selected={modelSel.set}
        onToggle={modelSel.toggle}
        onClear={modelSel.clear}
        inlineThreshold={6}
        placeholder="Search models…"
        disabled={searchActive}
      />

      <ModelMetaFilter
        rows={universe?.byModel ?? []}
        selected={modelSel.set}
        onApply={modelSel.addMany}
        disabled={searchActive}
      />
      </FilterAccordion>

      {overview.isLoading && <Skeleton label="PR overview" rows={4} className="py-4" />}
      {/* keepPreviousData turned a failed request from a blank section into a
          confident lie: the previous answer stays on screen indefinitely, under
          the NEW labels, with no signal that anything went wrong. Say so. */}
      {/* A failed request used to be silent: "Loading…" disappeared and the page
          simply stopped rendering, which reads as "there is no data" rather than
          "the query broke". keepPreviousData makes this worth saying out loud — a
          PR search is the slowest, most breakable endpoint on the page. (Verified
          behaviour: react-query v5 does NOT hold the placeholder across an error,
          so the stale answer is already gone; the banner explains the gap rather
          than dressing it up.) */}
      {overview.isError && (
        <QueryError error={overview.error} onRetry={() => { void overview.refetch(); }} live="assertive" retrying={overview.isFetching} />
      )}
      {d && d.totals.prs === 0 && (
        <div className="rounded-2xl border border-border-soft bg-surface px-5 py-10 text-center text-body text-ink-tertiary">
          {/* A search that misses must say which PR it missed, and whether a
              project filter narrowed it. "No PRs for this project and period"
              would be actively wrong here — the period is not in play.

              And it may only make that claim about rows that were fetched for that
              number: a zero-row PREVIOUS answer would otherwise read as "PR #58
              does not exist" while #58 is still in flight. */}
          {searchActive
            ? answerMatchesBox
              ? `No PR #${prNumber} found ${projectSel.set.size ? 'in the selected project' : 'in any project'} — it may belong to a different project, or was never reported through AgEnFK.`
              : `Searching for PR #${prNumber}…`
            : 'No PRs registered for this project and period.'}
        </div>
      )}

      {d && d.totals.prs > 0 && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="Total PRs"
              value={d.totals.prs}
              delta={prsDelta}
              hint={prsDelta == null ? '— no prior period' : undefined}
            />
            <StatTile
              label="Weighted size"
              value={d.totals.sizePoints}
              delta={sizeDelta}
              hint={<>{sizeDelta == null ? '— no prior period · ' : ''}size points · <a href="#size-derivation" className="underline decoration-dotted hover:text-ink">how size is derived</a></>}
            />
            <StatTile
              label="Active developers"
              value={d.totals.developers}
              hint={`${(d.totals.prs / Math.max(1, d.totals.developers)).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} PRs / dev`}
            />
            <StatTile label="Median size" value={(d.totals.medianBucket ?? '—').toUpperCase()} hint={`across ${d.totals.prs.toLocaleString()} PRs`} />
          </div>

          {/* Resize strip */}
          {d.resized.count > 0 && (
            <div className="flex items-center gap-3 flex-wrap rounded-xl border border-border-soft border-l-[3px] border-l-accent bg-surface px-4 py-3">
              <RefreshCw className="w-4 h-4 text-accent-ink" />
              <span className="text-body text-ink-secondary">
                <b className="text-ink">{d.resized.count} PRs re-sized</b> this period —{' '}
                <span className="text-ink font-semibold">{d.resized.grew} grew ↑</span>,{' '}
                <span className="text-ink font-semibold">{d.resized.shrank} shrank ↓</span>.
              </span>
              <span className="ml-auto text-caption text-ink-tertiary">Each PR counts once, at its latest sizing.</span>
            </div>
          )}

          {/* Daily stacked bar */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <h2 className="text-body font-semibold text-ink">PR volume by size</h2>
              <div className="flex items-center gap-3 flex-wrap">
                {SIZE_META.map(s => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 text-caption text-ink-tertiary">
                    <span className="w-3 h-3 rounded-sm" style={{ background: s.color }} /> {s.label}
                  </span>
                ))}
                <div className="inline-flex rounded-lg border border-border-soft bg-canvas p-0.5 text-caption font-medium" role="group" aria-label="Chart granularity">
                  {GRANULARITIES.map(g => (
                    <button
                      key={g.key}
                      onClick={() => setGran(g.key)}
                      aria-pressed={gran === g.key}
                      className={`px-2.5 py-1 rounded-md transition-colors ${gran === g.key
                        ? 'bg-surface text-accent-ink shadow-sm'
                        : 'text-ink-tertiary hover:text-ink'}`}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {volume && <PrVolumeChart series={volume} unit={GRANULARITIES.find(g => g.key === gran)?.unit ?? gran} />}
          </section>

          {/* By developer */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border-soft">
              <h2 className="text-body font-semibold text-ink">By developer</h2>
            </div>
            <DataTable
              caption="By developer"
              minWidth={720}
              rows={d.byDeveloper}
              rowKey={dev => dev.user_key}
              defaultSort={{ key: 'prs', dir: 'desc' }}
              columns={[
                {
                  key: 'dev',
                  header: 'Developer',
                  sortValue: dev => (nameOf(dev.user_key) ?? dev.user_key).toLowerCase(),
                  render: dev => (
                    <div className="flex items-center gap-2.5">
                      <PersonAvatar name={nameOf(dev.user_key)} userKey={dev.user_key} size="sm" />
                      <PersonName name={nameOf(dev.user_key)} userKey={dev.user_key} className="max-w-[200px]" />
                    </div>
                  ),
                },
                { key: 'prs', header: 'PRs', align: 'right', firstDir: 'desc', sortValue: dev => dev.prs, render: dev => <span className="font-mono tabular-nums text-title font-bold text-ink">{dev.prs}</span> },
                { key: 'pts', header: 'Size points', align: 'right', firstDir: 'desc', sortValue: dev => dev.sizePoints, render: dev => <span className="font-mono tabular-nums text-ink-secondary">{dev.sizePoints.toLocaleString()}</span> },
                { key: 'mix', header: 'Size mix', className: 'w-[180px]', render: dev => <MixBar sizes={dev.sizes} total={dev.prs} /> },
                { key: 'counts', header: 'XS · S · M · L · XL', render: dev => <SizeCounts sizes={dev.sizes} /> },
                { key: 'trend', header: 'Trend', align: 'right', render: dev => <div className="inline-block"><Sparkline daily={dev.daily} axis={axis} max={trendPeak} /></div> },
              ]}
            />
          </section>

          {/* By model */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border-soft">
              <h2 className="text-body font-semibold text-ink">By model</h2>
              <p className="text-caption text-ink-tertiary mt-0.5">Which agent runtime opened the PRs.</p>
            </div>
            <DataTable
              caption="By model"
              minWidth={560}
              rows={d.byModel}
              rowKey={m => m.model}
              defaultSort={{ key: 'prs', dir: 'desc' }}
              columns={[
                {
                  key: 'model',
                  header: 'Model',
                  sortValue: m => m.model.toLowerCase(),
                  render: m => (
                    <>
                      <div className="font-mono text-small text-ink-secondary">{m.model}</div>
                      {m.harnesses.length > 0 && <div className="text-caption text-ink-tertiary">via {m.harnesses.join(', ')}</div>}
                    </>
                  ),
                },
                { key: 'prs', header: 'PRs', align: 'right', firstDir: 'desc', sortValue: m => m.prs, render: m => <span className="font-mono tabular-nums text-title font-bold text-ink">{m.prs}</span> },
                { key: 'mix', header: 'Size mix', className: 'w-[180px]', render: m => <MixBar sizes={m.sizes} total={m.prs} /> },
                { key: 'counts', header: 'XS · S · M · L · XL', render: m => <SizeCounts sizes={m.sizes} /> },
                { key: 'share', header: 'Share', align: 'right', render: m => <span className="font-mono tabular-nums text-ink-secondary">{Math.round((m.prs / d.totals.prs) * 100)}%</span> },
              ]}
            />
          </section>

          {/* Per developer per day heatmap — calendar headers (month band +
              weekday/day per column), contribution pills per dev, and a styled
              tooltip on EVERY cell (the native title alone proved unreliable
              here, and 0-count cells previously lost hover to a nested div). */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5">
            <h2 className="text-body font-semibold text-ink mb-1">Per developer, per day</h2>
            <p className="text-caption text-ink-tertiary mb-4">Cell shade = PRs opened that day. Pills: share of PRs · share of size points.</p>
            {/* scroll-padding: a cell focused into view must land clear of the
                sticky name column (at most 190px plus the 4px gap), not under
                it. A scroll moves the cells out from under the tooltip. */}
            <div className="overflow-x-auto scroll-pl-[194px]" onScroll={() => setHeatTip(null)}>
              <div
                ref={heatGridRef}
                role="grid"
                aria-label="PRs per developer, per day. Use the arrow keys to move between days."
                onKeyDown={onHeatKey}
                className="grid gap-1 items-center min-w-[560px]"
                style={{ gridTemplateColumns: `minmax(150px, 190px) repeat(${Math.max(axis.length, 1)}, minmax(10px, 40px))` }}
              >
                {/* header row 1: month name spanning its day columns. Visual
                    only: each day header below names its own date. */}
                <div aria-hidden="true" className="contents">
                  <div className="sticky left-0 z-10 self-stretch bg-surface" />
                  {buildMonthBands(axis).map((band, i) => (
                    <div
                      key={`${band.label}-${i}`}
                      style={{ gridColumn: `span ${band.span}` }}
                      className="eyebrow text-center font-mono text-ink-tertiary border-b-2 border-border-soft pb-1"
                    >
                      {band.label}
                    </div>
                  ))}
                </div>

                {/* header row 2: weekday abbreviation + day number per column */}
                <div role="row" className="contents">
                <div role="columnheader" className="sticky left-0 z-10 self-stretch bg-surface"><span className="sr-only">Developer</span></div>
                {axis.map((day, i) => {
                  const h = dayInfos[i];
                  return (
                    <div
                      key={day}
                      role="columnheader"
                      aria-label={day}
                      data-testid="heatmap-day"
                      className={`text-center rounded-md py-0.5 ${h.isToday
                        ? 'bg-canvas outline outline-1 outline-accent'
                        : h.isWeekend ? 'bg-canvas' : ''}`}
                    >
                      <span className={`block font-mono text-caption uppercase leading-tight ${h.isWeekend ? 'text-ink-tertiary' : 'text-ink-tertiary'}`}>{/* One letter: at 11px a three-letter day overruns a 10px column; the full day is the column's aria-label. */}{h.weekday.charAt(0)}</span>
                      <span className={`block font-mono text-caption font-bold tabular-nums leading-tight ${h.isToday
                        ? 'text-accent-ink'
                        : h.isWeekend ? 'text-ink-tertiary' : 'text-ink-secondary'}`}>{h.dayNum}</span>
                    </div>
                  );
                })}
                </div>

                {/* one row per developer: name + contribution pills | day cells */}
                {d.byDeveloper.map((dev, ri) => {
                  const max = Math.max(1, ...axis.map(day => dev.daily[day] ?? 0));
                  const pct = contributionPcts(dev, d.totals);
                  return (
                    <div key={dev.user_key} role="row" className="contents">
                      {/* sticky so names + pills stay visible when the day axis scrolls */}
                      <div role="rowheader" className="sticky left-0 z-10 self-stretch flex items-center gap-2 pr-2 min-w-0 bg-surface">
                        {nameOf(dev.user_key)
                          ? <span title={dev.user_key} className="text-caption text-ink-secondary truncate">{labelOf(dev.user_key)}</span>
                          : <span title={dev.user_key} className="font-mono text-caption text-ink-tertiary truncate">{dev.user_key}</span>}
                        {/* stacked vertically so long dev emails keep the width */}
                        <span className="ml-auto flex flex-col items-end gap-0.5 shrink-0">
                          <span title={`${pct.prPct}% share of all PRs in the period`} className="text-caption font-semibold tabular-nums whitespace-nowrap rounded-full px-1.5 py-px text-accent-ink bg-accent-fill border border-accent">{pct.prPct}% of PRs</span>
                          <span title={`${pct.ptsPct}% share of all size points in the period`} className="text-caption font-semibold tabular-nums whitespace-nowrap rounded-full px-1.5 py-px text-ink-secondary bg-canvas border border-border-soft">{pct.ptsPct}% of size</span>
                        </span>
                      </div>
                      {axis.map((day, i) => {
                        const c = dev.daily[day] ?? 0;
                        const h = dayInfos[i];
                        const intensity = c === 0 ? 0 : c / max; // heatColor owns the visible floor
                        const tip = cellTooltip(labelOf(dev.user_key), day, c);
                        // The cell's one focus target: the drill button of a day
                        // with PRs, else the empty cell itself. Only the grid's
                        // stop is tabbable; the arrow keys reach the rest.
                        const target = {
                          'data-cell': `${ri}-${i}`,
                          tabIndex: heatStop.r === ri && heatStop.c === i ? 0 : -1,
                          onFocus: (e: React.FocusEvent<HTMLElement>) => { setHeatPos({ r: ri, c: i }); heatTipOnFocus(tip, e.currentTarget); },
                          onBlur: () => setHeatTip(null),
                        };
                        return (
                          <div
                            key={day}
                            role="gridcell"
                            onMouseEnter={showHeatTip(tip)}
                            onMouseLeave={() => setHeatTip(null)}
                            {...(c === 0 ? { ...target, 'aria-label': `No PRs by ${labelOf(dev.user_key)} on ${day}` } : {})}
                            className={`aspect-square rounded-[3px] ${HEAT_FOCUS_RING} ${c === 0
                              ? h.isWeekend
                                ? 'bg-transparent border border-dashed border-ink-tertiary/40'
                                : 'bg-border-soft'
                              : 'cursor-pointer hover:opacity-75 transition-opacity'}`}
                            style={{ background: c === 0 ? undefined : heatColor(intensity) }}
                          >
                            {c > 0 && (
                              // CGLAB-131 — a day with PRs opens its list (the
                              // drill clears the tooltip so it cannot peek out
                              // from the modal).
                              <button
                                type="button"
                                {...target}
                                aria-label={`${c} PR${c === 1 ? '' : 's'} by ${labelOf(dev.user_key)} on ${day} — open list`}
                                onClick={() => openDrill(dev.user_key, day)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrill(dev.user_key, day); }
                                }}
                                className={`block w-full h-full rounded-[3px] cursor-pointer ${HEAT_FOCUS_RING}`}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* CGLAB-131 — deliberately OUTSIDE the heatmap section above: a
              backdrop-filter ancestor would re-root these fixed coordinates
              (the "tooltip far away" defect) and swallow the z-50 (the z-order
              defect). Coordinates are viewport-relative, from placeTooltip. */}
          {heatTip && (
            <div
              className={`pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-surface text-ink border border-border-soft font-mono text-caption px-2 py-1 shadow-lg ${heatTip.below ? '' : '-translate-y-full'}`}
              style={{ left: heatTip.x, top: heatTip.y }}
            >
              {heatTip.text}
            </div>
          )}
          {drill && <PrDrilldownModal dev={drill.dev} day={drill.day} prs={drillPrs} onClose={closeDrill} />}

          {/* Size model explainer */}
          <section className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl p-5">
            <h2 id="size-derivation" className="text-body font-semibold text-ink mb-3 scroll-mt-4">How size is derived</h2>
            <div className="font-mono text-body rounded-lg bg-canvas border border-border-soft px-4 py-3 text-ink-secondary">
              <span className="text-ink-tertiary">// count leaves — the unit of work in each branch</span><br />
              <span className="text-accent-ink">size_points</span> = leafStory·<b>4</b> + task·<b>2</b> + bug·<b>1</b>
            </div>
            <p className="text-small text-ink-tertiary mt-3 max-w-prose">
              An Epic rolls up its Stories, and a Story rolls up its Tasks &amp; Bugs — so summing all four tiers
              double-counts. We size by the atomic deliverables; a Story with no subtasks is itself a leaf and scores ×4.
              A later re-size re-buckets the same PR (it never adds a second one), and the PR is attributed to its opener.
            </p>
            <div className="flex gap-2 flex-wrap mt-3 text-caption font-mono">
              {[{ b: 'XS', r: '0–2' }, { b: 'S', r: '3–6' }, { b: 'M', r: '7–14' }, { b: 'L', r: '15–30' }, { b: 'XL', r: '31+' }].map((x, i) => (
                <span key={x.b} className="inline-flex items-center gap-1.5 rounded-md border border-border-soft px-2 py-1">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(SIZE_META[i].key) }} />
                  <b>{x.b}</b> <span className="text-ink-tertiary">{x.r} pts</span>
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </Page>
  );
}
