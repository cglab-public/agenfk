import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { FilterAccordion, FILTERS_OPEN, parseFiltersOpen } from '../components/FilterAccordion';
import { describeFilters } from '../filterSummary';
import { ChipRow, DataTable, Page, PageHeader, PeriodControl, QueryState, StatTile } from '../components/ui';
import { shortRemote } from '../components/facetSearch';
import { mergeEventTypes } from '../eventTypes';
import { EventTypeChips } from '../components/EventTypeChips';
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

interface AdherenceResponse {
  /** Transitions the server could judge: stamped with the flow revision in force. */
  judged: number;
  compliant: number;
  /** compliant / judged, or null when nothing was judged — never render 0% for that. */
  score: number | null;
  series: Array<{ day: string; judged: number; compliant: number; score: number | null }>;
}
interface EventTypesResponse { types: string[] }
interface ProjectsResponse { projects: string[] }
interface ItemTypesResponse { itemTypes: string[]; counts?: Record<string, number> }

const KNOWN_ITEM_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG'] as const;

const pctOf = (compliant: number, judged: number) => Math.round((compliant / judged) * 100);

const ADHERENCE_FILTER_KEYS = ['types', 'projects', 'itemTypes', 'range'] as const;

/** The score as a human reads it: a whole percent, or an explicit dash when the
 *  window judged nothing. A null score is missing data, not a terrible score. */
function Score({ compliant, judged }: { compliant: number; judged: number }) {
  if (!judged) {
    return (
      <span className="text-ink-tertiary">
        <span aria-hidden="true" title="nothing judged">—</span>
        <span className="sr-only">nothing judged</span>
      </span>
    );
  }
  const pct = pctOf(compliant, judged);
  return (
    <span className="font-mono tabular-nums text-ink">
      <span aria-hidden="true" title={`${compliant} of ${judged} moves between steps of the flow`}>{pct}%</span>
      <span className="sr-only">{`${pct}%, ${compliant} of ${judged} moves between steps of the flow`}</span>
    </span>
  );
}

export function AdherencePage() {
  // The URL is the only source of truth, exactly as on the Org page: a reload
  // or a shared link shows the same view; a bare visit opens as this browser
  // left it. A link that names a filter always wins.
  const filters = useUrlFilters({ keys: ADHERENCE_FILTER_KEYS, storageKey: 'agenfk-hub:adherence:filters' });
  const fp = filters.params;
  // No default event-type selection, unlike Org's item.closed: adherence is
  // about step.transitioned, and a defaulted chip list would judge nothing.
  const eventTypeSel = useToggleSet(csvParam(fp, 'types'));
  const projectSel = useToggleSet(csvParam(fp, 'projects'));
  const itemTypeSel = useToggleSet(csvParam(fp, 'itemTypes'));
  const range = (RANGES.some(r => r.key === fp.get('range')) ? fp.get('range') : '30d') as RangeKey;
  const setRange = (r: RangeKey) => filters.write({ range: r });

  // The child hub is a scope someone sends; it is never remembered for a bare
  // visit (the Org page's rule).
  const [searchParams] = useSearchParams();
  const childHubSel = useToggleSet(csvParam(searchParams, 'childHubId'));
  const childHubs = useChildHubs(childHubSel.set);

  // ONE writer for the query string — a second effect writing in the same tick
  // would undo the first (Org page's comment; the bug it records is general).
  const { write: writeFilters } = filters;
  useEffect(() => {
    writeFilters({
      types: [...eventTypeSel.set].join(','),
      projects: projectSel.set.size ? [...projectSel.set].join(',') : null,
      itemTypes: itemTypeSel.set.size ? [...itemTypeSel.set].join(',') : null,
      childHubId: childHubSel.set.size ? [...childHubSel.set].join(',') : null,
    });
  }, [eventTypeSel.set, projectSel.set, itemTypeSel.set, childHubSel.set, writeFilters]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (itemTypeSel.set.size) p.set('itemTypes', [...itemTypeSel.set].join(','));
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    p.set('from', fromIsoForRange(new Date(), range));
    return p.toString();
  }, [projectSel.set, itemTypeSel.set, childHubSel.set, eventTypeSel.set, range]);

  const adherence = useQuery<AdherenceResponse>({
    queryKey: ['adherence', qs],
    queryFn: async () => (await api.get(`/v1/adherence${qs ? `?${qs}` : ''}`)).data,
  });

  // The facet lists are partitioned by hub, not narrowed by the other filters —
  // offering a repo from a hub the board is not showing is a dead end.
  const hubQs = childHubSel.set.size
    ? `?${new URLSearchParams({ childHubId: [...childHubSel.set].join(',') })}`
    : '';
  const itemTypesQs = useMemo(() => {
    const p = new URLSearchParams();
    if (projectSel.set.size) p.set('projects', [...projectSel.set].join(','));
    if (eventTypeSel.set.size) p.set('types', [...eventTypeSel.set].join(','));
    if (childHubSel.set.size) p.set('childHubId', [...childHubSel.set].join(','));
    return p.toString();
  }, [projectSel.set, eventTypeSel.set, childHubSel.set]);
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

  const types = mergeEventTypes(eventTypes.data?.types);
  const projectOptions = projects.data?.projects ?? [];
  const itemTypeOptions = useMemo(() => {
    const set = new Set<string>(KNOWN_ITEM_TYPES);
    for (const t of itemTypes.data?.itemTypes ?? []) set.add(t);
    return [...set].sort();
  }, [itemTypes.data]);

  const d = adherence.data;
  const offFlow = d ? d.judged - d.compliant : 0;

  return (
    <Page>
      <PageHeader
        eyebrow="Dashboard"
        title="Flow adherence"
        subtitle="How often work moved between steps of the flow, across every connected installation."
        toolbar={<PeriodControl ranges={RANGES} active={range} onPick={setRange} />}
      />

      {/* The scoring rule, stated where the numbers are: a reader should not
          have to discover it from a surprising tile. The revision is not the
          thing being measured — it only records which immutable flow judged
          the move. */}
      <p className="text-caption text-ink-tertiary">
        A move counts as compliant when both its start and end are steps of the flow — rolling back is working the flow, not breaking it.
        Moves to or from PAUSED, BLOCKED or anything off-flow are not. Transitions from before flows were stamped count on neither side.
      </p>

      <QueryState
        query={adherence}
        label="adherence"
        isEmpty={data => data.judged === 0}
        empty={(
          <div className="bg-card-glass border border-border-soft rounded-2xl px-5 py-8 text-center text-body text-ink-tertiary">
            {eventTypeSel.set.size
              ? 'Nothing was judged in this window. Only Step changed transitions are judged, and the selected event types exclude them.'
              : 'Nothing was judged in this window — no transition was stamped with a flow revision here.'}
          </div>
        )}
      >
        {data => (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatTile label="Score" value={data.judged ? `${pctOf(data.compliant, data.judged)}%` : '—'} hint={`${data.compliant} of ${data.judged} moves between steps of the flow`} />
              <StatTile label="Judged" value={data.judged} hint="moves the flow could judge" />
              <StatTile label="Compliant" value={data.compliant} series={1} hint="started and ended on flow steps" />
              <StatTile label="Off-flow" value={offFlow} higherIsBetter={false} hint="touched a non-step (PAUSED, BLOCKED, …)" />
            </div>

            <section className="space-y-3 pt-2">
              <h2 className="text-body font-semibold text-ink-secondary">By day</h2>
              <div className="bg-card-glass backdrop-blur border border-border-soft rounded-2xl overflow-hidden">
                <DataTable
                  caption="Flow adherence by day"
                  minWidth={520}
                  rows={data.series}
                  rowKey={r => r.day}
                  columns={[
                    { key: 'day', header: 'Day', sortValue: r => r.day, render: r => <span className="font-mono text-small text-ink">{r.day}</span> },
                    { key: 'judged', header: 'Judged', align: 'right', firstDir: 'desc', sortValue: r => r.judged, render: r => <span className="font-mono tabular-nums text-ink">{r.judged.toLocaleString()}</span> },
                    { key: 'compliant', header: 'Compliant', align: 'right', firstDir: 'desc', sortValue: r => r.compliant, render: r => <span className="font-mono tabular-nums text-ink">{r.compliant.toLocaleString()}</span> },
                    { key: 'score', header: 'Score', align: 'right', firstDir: 'desc', sortValue: r => r.score ?? -1, render: r => <Score compliant={r.compliant} judged={r.judged} /> },
                  ]}
                />
              </div>
            </section>
          </>
        )}
      </QueryState>

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
    </Page>
  );
}
