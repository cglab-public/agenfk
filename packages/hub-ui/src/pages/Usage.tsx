/**
 * GH-389 follow-up: the hub's /usage page. AI usage (tokens and cost) across
 * the org over the board filters, by installation, by person, by harness and
 * model, and by PR, from GET /v1/usage/overview.
 *
 * Cost: harnesses that price their own turns (pi) report it; for the rest it
 * is ESTIMATED from the shared price table (@agenfk/flow-editor, the same one
 * the board uses) and labelled so. What the hub cannot see is said on the page.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { estimateCost, parsePrices, PRICES_URL, type CostView, type PricedModelUsage, type PricesData } from '@agenfk/flow-editor';
import { api } from '../api';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { FilterAccordion, FILTERS_OPEN, parseFiltersOpen } from '../components/FilterAccordion';
import { describeFilters } from '../filterSummary';
import { ChipRow, DataTable, Page, PageHeader, PeriodControl, QueryState, StatTile } from '../components/ui';
import { shortRemote } from '../components/facetSearch';
import { PersonName } from '../components/PersonName';
import { usePeopleNames } from '../hooks/usePeopleNames';
import { useToggleSet } from '../hooks/useToggleSet';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { useChildHubs } from '../hooks/useChildHubs';
import { csvParam } from '../urlParams';
import { fromIsoForRange, type RangeKey } from '../components/timelineAxis';
import { DailyBarChart, type BarSeries } from '../components/DailyBarChart';
import { ALL_EVENTS_COLOR, OTHER_COLOR } from '../chartColours';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];
const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;
const USAGE_FILTER_KEYS = ['projects', 'itemTypes', 'range'] as const;

interface Totals {
  turns: number; input: number; cacheRead: number; cacheWrite: number;
  output: number; reasoning: number; costUsd: number; unpricedTurns: number;
}
type ModelRow = Totals & { client: string; model: string };
interface Group { cards: number; total: Totals; byModel: ModelRow[] }
interface PrRow {
  repo: string; pr_number: number; item_id: string; item_type: string | null; item_title: string | null;
  opened_at: string; closed_at: string | null;
  usage: { total: Totals; byModel: ModelRow[]; cards?: number } | null;
}
export interface UsageOverview {
  total: Totals;
  cards: number;
  steps: number;
  unmeasuredSteps: number;
  incompleteSteps: number;
  recoveredAtClose: Totals;
  byInstallation: Array<Group & { installation_id: string; label: string | null }>;
  byUser: Array<Group & { user_key: string }>;
  byModel: ModelRow[];
  byPr: PrRow[];
  byDay: Array<Group & { day: string }>;
  /** GH-394: usage on no card, in `total` and in none of the card breakdowns. Absent from an older hub. */
  noCard?: NoCardUsage;
  truncated: boolean;
  prsTruncated: boolean;
}
interface Usage { total: Totals; byModel: ModelRow[] }
interface NoCardUsage extends Usage {
  byDay: Array<Usage & { day: string }>;
  byInstallation: Array<Usage & { installation_id: string; label: string | null }>;
  byUser: Array<Usage & { user_key: string }>;
}
type InstallationRow = UsageOverview['byInstallation'][number];
type PersonRow = UsageOverview['byUser'][number];
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[]; counts?: Record<string, number> }

const tokensOf = (t: Totals) => t.input + t.cacheRead + t.cacheWrite + t.output;
/**
 * The four token types the total is made of, each shown on its own. Reasoning
 * is left out: some harnesses count it inside output, so it is not a fifth part.
 */
const TOKEN_TYPES = [
  { key: 'input', label: 'Input', color: 'var(--series-1)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--series-2)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--series-4)' },
  { key: 'output', label: 'Output', color: 'var(--series-3)' },
] as const satisfies ReadonlyArray<{ key: keyof Totals; label: string; color: string }>;
/**
 * Usage on no card, as its own part of the daily charts: striped in the neutral
 * colour, because it is all four token types at once and no one of them.
 */
const NO_CARD_LABEL = 'Not on a card';
const NO_CARD_SERIES: BarSeries = { label: NO_CARD_LABEL, color: OTHER_COLOR, pattern: 'hatched' };
/** The cost chart's other part when usage on no card is beside it. */
const ON_CARD_SERIES: BarSeries = { label: 'On a card', color: ALL_EVENTS_COLOR };
/** The key of the "Not on a card" row each table ends with. */
const NO_CARD_ROW = '\u0000no-card';
const hasTotals = (t: Totals | null | undefined): t is Totals => !!t && (t.turns > 0 || tokensOf(t) > 0);
const hasUsage = (u: Usage | null | undefined): u is Usage => !!u && hasTotals(u.total);
const typeSplit = (t: Totals) => TOKEN_TYPES.map(type => `${type.label.toLowerCase()} ${abbreviate(t[type.key])}`).join(' · ');
/** Two costs as one: reported and estimated added, the models named once. */
function addCost(a: CostView, b: CostView): CostView {
  return {
    reported: a.reported + b.reported,
    estimated: a.estimated + b.estimated,
    unpricedModels: [...new Set([...a.unpricedModels, ...b.unpricedModels])],
    estimatedModels: [...new Set([...a.estimatedModels, ...b.estimatedModels])],
  };
}
const NoCardName = () => <span className="text-body italic text-ink-secondary">{NO_CARD_LABEL}</span>;

/** 950, 42k, 3.7M: the size of a total at a glance. */
function abbreviate(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
function money(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
/** The viewer's time zone, so the hub files usage under the viewer's days. */
const viewerZone = (): string | null => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
/** Every day from `fromIso` to today (the viewer's days), oldest first. */
function daysSince(fromIso: string, now = new Date()): string[] {
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const out: string[] = [];
  const d = new Date(fromIso);
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < 400 && key(d) <= key(now); i++) { out.push(key(d)); d.setDate(d.getDate() + 1); }
  return out;
}
/**
 * Today's local date, moving at midnight: 'today' and every range start are
 * re-derived from it, so a page left open overnight asks for the new day.
 */
function useLocalDay(): string {
  const key = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const [day, setDay] = useState(key);
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    const t = setTimeout(() => setDay(key()), midnight.getTime() - now.getTime());
    return () => clearTimeout(t);
  }, [day]);
  return day;
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A row's cost: reported plus estimated, the estimate and anything unpriced said beside it. */
function Cost({ byModel, prices }: { byModel: PricedModelUsage[]; prices: PricesData | undefined }) {
  const c = estimateCost(byModel, prices);
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
      <span className="font-mono tabular-nums text-ink">{money(c.reported + c.estimated)}</span>
      {c.estimated > 0 && <span className="text-caption text-ink-tertiary" title="estimated from the public price table">est.</span>}
      {c.unpricedModels.length > 0 && (
        <span className="text-caption text-ink-tertiary">{`not priced: ${c.unpricedModels.join(', ')}`}</span>
      )}
    </span>
  );
}
const Tokens = ({ t }: { t: Totals }) => <TokenCount n={tokensOf(t)} />;
const TokenCount = ({ n }: { n: number }) => (
  <span className="font-mono tabular-nums text-ink" title={`${n.toLocaleString()} tokens`}>{abbreviate(n)}</span>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3 pt-2">
      <h2 className="text-body font-semibold text-ink-secondary">{title}</h2>
      <div className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">{children}</div>
    </section>
  );
}

export function UsagePage() {
  const filters = useUrlFilters({ keys: USAGE_FILTER_KEYS, storageKey: 'agenfk-hub:usage:filters' });
  const fp = filters.params;
  const projectSel = useToggleSet(csvParam(fp, 'projects'));
  const itemTypeSel = useToggleSet(csvParam(fp, 'itemTypes'));
  const range = (RANGES.some(r => r.key === fp.get('range')) ? fp.get('range') : '30d') as RangeKey;
  const setRange = (r: RangeKey) => filters.write({ range: r });
  // The child hub is a scope someone sends; never remembered for a bare visit.
  const [searchParams] = useSearchParams();
  const childHubSel = useToggleSet(csvParam(searchParams, 'childHubId'));
  const childHubs = useChildHubs(childHubSel.set);
  const nameOf = usePeopleNames();
  const today = useLocalDay();

  const { write: writeFilters } = filters;
  useEffect(() => {
    writeFilters({
      projects: projectSel.set.size ? [...projectSel.set].join(',') : null,
      itemTypes: itemTypeSel.set.size ? [...itemTypeSel.set].join(',') : null,
      childHubId: childHubSel.set.size ? [...childHubSel.set].join(',') : null,
    });
  }, [projectSel.set, itemTypeSel.set, childHubSel.set, writeFilters]);

  // No event types: the overview always reads the usage events themselves.
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    p.set('from', fromIsoForRange(new Date(), range));
    const tz = viewerZone();
    if (tz) p.set('tz', tz);
    return p.toString();
    // today: the range start moves at local midnight.
  }, [projectSel.set, itemTypeSel.set, childHubSel.set, range, today]);

  const overview = useQuery<UsageOverview>({
    queryKey: ['usage-overview', qs],
    queryFn: async () => (await api.get(`/v1/usage/overview?${qs}`)).data,
  });
  // The public price table, as on the board. Unavailable: only reported cost.
  const prices = useQuery<PricesData>({
    queryKey: ['prices'],
    queryFn: async () => {
      const res = await fetch(PRICES_URL);
      if (!res.ok) throw new Error(`price table: ${res.status}`);
      return parsePrices(await res.json());
    },
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const hubQs = childHubSel.set.size ? `?${new URLSearchParams({ childHubId: [...childHubSel.set].join(',') })}` : '';
  const projects = useQuery<ProjectsResponse>({
    queryKey: ['projects', hubQs],
    queryFn: async () => (await api.get(`/v1/projects${hubQs}`)).data,
  });
  const itemTypesQs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    return p.toString();
  }, [projectSel.set, childHubSel.set]);
  const itemTypes = useQuery<ItemTypesResponse>({
    queryKey: ['item-types', itemTypesQs],
    queryFn: async () => (await api.get(`/v1/item-types${itemTypesQs ? `?${itemTypesQs}` : ''}`)).data,
  });
  const itemTypeOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_ITEM_TYPES);
    for (const t of itemTypes.data?.itemTypes ?? []) set.add(t);
    return [...set].sort();
  }, [itemTypes.data]);

  const priceTable = prices.data;
  const costCol = <T,>(models: (r: T) => ModelRow[]) => ({
    key: 'cost', header: 'Cost', align: 'right' as const, firstDir: 'desc' as const,
    sortValue: (r: T) => { const c = estimateCost(models(r), priceTable); return c.reported + c.estimated; },
    render: (r: T) => <Cost byModel={models(r)} prices={priceTable} />,
  });
  const tokensCol = <T,>(total: (r: T) => Totals) => ({
    key: 'tokens', header: 'Tokens', align: 'right' as const, firstDir: 'desc' as const,
    sortValue: (r: T) => tokensOf(total(r)), render: (r: T) => <Tokens t={total(r)} />,
  });
  /** A column per token type, beside the total; a row with no usage yet shows none. */
  const typeCols = <T,>(total: (r: T) => Totals | null) => TOKEN_TYPES.map(type => ({
    key: type.key, header: type.label, align: 'right' as const, firstDir: 'desc' as const,
    sortValue: (r: T) => total(r)?.[type.key] ?? null,
    render: (r: T) => { const t = total(r); return t ? <TokenCount n={t[type.key]} /> : null; },
  }));
  const cardsCol = <T extends { cards: number },>() => ({
    key: 'cards', header: 'Cards', align: 'right' as const, firstDir: 'desc' as const,
    sortValue: (r: T) => r.cards, render: (r: T) => <span className="font-mono tabular-nums text-ink">{r.cards.toLocaleString()}</span>,
  });

  return (
    <Page>
      <PageHeader
        eyebrow="Dashboard"
        title="Usage"
        subtitle="AI tokens and cost across every connected installation, from the harnesses' session logs."
        toolbar={<PeriodControl ranges={RANGES} active={range} onPick={setRange} />}
      />
      <p className="text-caption text-ink-tertiary">
        Usage reaches the hub when a card changes step: a card's current step is counted when it moves on.
        Usage on no card arrives as each installation's daily total per project, a few times a day, and is in the totals.
        Cost is what pi reported plus, for Claude Code and Codex, an estimate from the public price table, marked est.
      </p>

      <FilterAccordion
        activeCount={[projectSel.set, itemTypeSel.set, childHubSel.set].filter(x => x.size > 0).length}
        summary={describeFilters({
          range,
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
          options={projects.data?.projects ?? []}
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
      </FilterAccordion>

      <QueryState
        query={overview}
        label="usage"
        // Empty only when there is also nothing to warn about: a window of unmeasured steps says so.
        isEmpty={d => tokensOf(d.total) === 0 && d.total.turns === 0 && d.byPr.length === 0
          && !d.unmeasuredSteps && !d.incompleteSteps && !d.truncated && !d.prsTruncated}
        empty={(
          <div className="bg-card-glass border border-border-soft rounded-2xl px-5 py-8 text-center text-body text-ink-tertiary">
            No usage was recorded in this window.
          </div>
        )}
      >
        {d => {
          const nc = hasUsage(d.noCard) ? d.noCard! : null;
          const ncCost = nc ? estimateCost(nc.byModel, priceTable) : null;
          const cardCost = estimateCost(d.byModel, priceTable);
          const cost = ncCost ? addCost(cardCost, ncCost) : cardCost;
          // Every day of the range (a quiet day is a zero bar), plus any day the hub filed outside it.
          const dayRows = new Map((d.byDay ?? []).map(r => [r.day, r] as const));
          const ncDays = new Map((nc?.byDay ?? []).map(r => [r.day, r] as const));
          const days = [...new Set([...daysSince(fromIsoForRange(new Date(), range)), ...dayRows.keys(), ...ncDays.keys()])].sort();
          const people = new Set([...d.byUser.map(r => r.user_key), ...(nc?.byUser ?? []).map(r => r.user_key)]).size;
          const installations = new Set([...d.byInstallation.map(r => r.installation_id), ...(nc?.byInstallation ?? []).map(r => r.installation_id)]).size;
          const ncInstallationRow: InstallationRow[] = nc ? [{ installation_id: NO_CARD_ROW, label: NO_CARD_LABEL, cards: 0, total: nc.total, byModel: nc.byModel }] : [];
          const ncPersonRow: PersonRow[] = nc ? [{ user_key: NO_CARD_ROW, cards: 0, total: nc.total, byModel: nc.byModel }] : [];
          const ncModelRow: ModelRow[] = nc ? [{ client: '', model: NO_CARD_LABEL, ...nc.total }] : [];
          const isNoCardModel = (r: ModelRow) => !!nc && r === ncModelRow[0];
          const modelsOfRow = (r: ModelRow): ModelRow[] => (isNoCardModel(r) ? nc!.byModel : [r]);
          const notes: string[] = [];
          if (d.unmeasuredSteps > 0) notes.push(`${plural(d.unmeasuredSteps, 'step change', 'step changes')} came from versions that did not report usage, and are not counted.`);
          if (d.incompleteSteps > 0) notes.push(`${plural(d.incompleteSteps, 'step change', 'step changes')}: its session logs could not be read in time; turns found later are added at the card's next step change or close.`);
          if (d.truncated) notes.push('Too many step changes in this window: only the newest were added up. Narrow the window or the filters.');
          if (d.prsTruncated) notes.push('Only the newest 1,000 PRs are listed.');
          return (
            <>
              <section aria-label="Totals" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatTile
                  label="Tokens"
                  value={abbreviate(tokensOf(d.total))}
                  hint={(
                    <span className="flex flex-col">
                      <span>{`${tokensOf(d.total).toLocaleString()} across ${plural(d.total.turns, 'turn', 'turns')}`}</span>
                      <span>{typeSplit(d.total)}</span>
                      {nc && <span>{`of which ${abbreviate(tokensOf(nc.total))} not on a card`}</span>}
                    </span>
                  )}
                />
                <StatTile
                  label="Cost"
                  value={money(cost.reported + cost.estimated)}
                  hint={(
                    <span className="flex flex-col">
                      {cost.estimated > 0 && <span>{`includes ${money(cost.estimated)} estimated`}</span>}
                      {cost.unpricedModels.length > 0 && <span>{`not priced: ${cost.unpricedModels.join(', ')}`}</span>}
                      {ncCost && <span>{`of which ${money(ncCost.reported + ncCost.estimated)} not on a card`}</span>}
                    </span>
                  )}
                />
                <StatTile label="Cards" value={d.cards} hint="that recorded usage" />
                <StatTile label="People" value={people} hint={plural(installations, 'installation', 'installations')} />
              </section>

              {notes.length > 0 && (
                <ul className="text-caption text-ink-secondary list-disc pl-5 space-y-1">
                  {notes.map(n => <li key={n}>{n}</li>)}
                </ul>
              )}

              <DailyBarChart
                title="Cost per day"
                bars={days.map(day => {
                  const g = dayRows.get(day);
                  const n = ncDays.get(day);
                  if (!g && !n) return { day, value: 0, ...(nc ? { parts: [0, 0] } : {}) };
                  const onCard = estimateCost(g?.byModel ?? [], priceTable);
                  const offCard = estimateCost(n?.byModel ?? [], priceTable);
                  const c = addCost(onCard, offCard);
                  const note = [
                    c.estimated > 0 ? `includes ${money(c.estimated)} estimated` : '',
                    c.unpricedModels.length ? `not priced: ${c.unpricedModels.join(', ')}` : '',
                  ].filter(Boolean).join('; ');
                  const parts = nc ? { parts: [onCard.reported + onCard.estimated, offCard.reported + offCard.estimated] } : {};
                  return { day, value: c.reported + c.estimated, ...parts, ...(note ? { note } : {}) };
                })}
                format={money}
                tickFormat={v => (v === 0 ? '$0' : money(v))}
                scale={100}
                {...(nc ? { series: [ON_CARD_SERIES, NO_CARD_SERIES] } : {})}
              />
              <DailyBarChart
                title="Tokens per day"
                bars={days.map(day => {
                  const t = dayRows.get(day)?.total;
                  const n = ncDays.get(day)?.total;
                  const parts = TOKEN_TYPES.map(type => (t ? t[type.key] : 0));
                  if (nc) parts.push(n ? tokensOf(n) : 0);
                  const note = hasTotals(n) ? { note: `not on a card: ${typeSplit(n)}` } : {};
                  return { day, value: parts.reduce((a, b) => a + b, 0), parts, ...note };
                })}
                format={v => `${abbreviate(v)} tokens`}
                tickFormat={abbreviate}
                series={[...TOKEN_TYPES.map(({ label, color }) => ({ label, color })), ...(nc ? [NO_CARD_SERIES] : [])]}
              />

              <Section title="By installation">
                <DataTable
                  caption="Usage by installation"
                  minWidth={880}
                  rows={d.byInstallation}
                  pinned={ncInstallationRow}
                  rowKey={r => r.installation_id}
                  columns={[
                    { key: 'installation', header: 'Installation', sortValue: r => r.label ?? r.installation_id,
                      render: r => (r.installation_id === NO_CARD_ROW ? <NoCardName />
                        : <span className={r.label ? 'text-body text-ink break-words' : 'font-mono text-small text-ink break-all'}>{r.label ?? r.installation_id}</span>) },
                    cardsCol<InstallationRow>(), tokensCol<InstallationRow>(r => r.total), ...typeCols<InstallationRow>(r => r.total), costCol<InstallationRow>(r => r.byModel),
                  ]}
                />
              </Section>

              <Section title="By person">
                <DataTable
                  caption="Usage by person"
                  minWidth={880}
                  rows={d.byUser}
                  pinned={ncPersonRow}
                  rowKey={r => r.user_key}
                  columns={[
                    { key: 'person', header: 'Person', sortValue: r => nameOf(r.user_key) ?? r.user_key,
                      render: r => (r.user_key === NO_CARD_ROW ? <NoCardName /> : <PersonName name={nameOf(r.user_key)} userKey={r.user_key} />) },
                    cardsCol<PersonRow>(), tokensCol<PersonRow>(r => r.total), ...typeCols<PersonRow>(r => r.total), costCol<PersonRow>(r => r.byModel),
                  ]}
                />
              </Section>

              <Section title="By harness and model">
                <DataTable
                  caption="Usage by harness and model"
                  minWidth={960}
                  rows={d.byModel}
                  pinned={ncModelRow}
                  rowKey={r => `${r.client}/${r.model}`}
                  columns={[
                    { key: 'model', header: 'Model', sortValue: r => r.model,
                      render: r => (isNoCardModel(r) ? <NoCardName /> : <span className="font-mono text-small text-ink break-all">{r.model}</span>) },
                    { key: 'harness', header: 'Harness', sortValue: r => r.client, render: r => <span className="text-small text-ink-secondary">{r.client}</span> },
                    { key: 'turns', header: 'Turns', align: 'right', firstDir: 'desc', sortValue: r => r.turns,
                      render: r => <span className="font-mono tabular-nums text-ink">{r.turns.toLocaleString()}</span> },
                    tokensCol<ModelRow>(r => r), ...typeCols<ModelRow>(r => r), costCol<ModelRow>(modelsOfRow),
                  ]}
                />
              </Section>

              <Section title="By PR">
                <p className="px-4 pt-3 text-caption text-ink-tertiary">
                  A PR's usage is its card's, sub-cards included, as of the card's close.
                </p>
                {d.byPr.length === 0 ? (
                  <p className="px-4 pb-4 text-body text-ink-tertiary">No PR was opened or updated in this window.</p>
                ) : (
                  <DataTable
                  caption="Usage by PR"
                  minWidth={960}
                  rows={d.byPr}
                  rowKey={r => `${r.repo}#${r.pr_number}`}
                  columns={[
                    { key: 'pr', header: 'PR', sortValue: r => r.opened_at,
                      render: r => <span className="font-mono text-small text-ink">{`${r.repo}#${r.pr_number}`}</span> },
                    { key: 'card', header: 'Card', sortValue: r => r.item_title ?? r.item_id,
                      render: r => <span className="text-body text-ink break-words">{r.item_title ?? r.item_id}</span> },
                    { key: 'tokens', header: 'Tokens', align: 'right', firstDir: 'desc', sortValue: r => (r.usage ? tokensOf(r.usage.total) : null),
                      render: r => (r.usage ? <Tokens t={r.usage.total} /> : <span className="text-caption text-ink-tertiary">not closed yet</span>) },
                    ...typeCols<PrRow>(r => r.usage?.total ?? null),
                    { key: 'cost', header: 'Cost', align: 'right', firstDir: 'desc',
                      sortValue: r => { if (!r.usage) return null; const c = estimateCost(r.usage.byModel ?? [], priceTable); return c.reported + c.estimated; },
                      render: r => (r.usage ? <Cost byModel={r.usage.byModel ?? []} prices={priceTable} /> : null) },
                  ]}
                />
                )}
              </Section>
            </>
          );
        }}
      </QueryState>

    </Page>
  );
}
