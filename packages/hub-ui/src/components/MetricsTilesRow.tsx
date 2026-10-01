import { StatTile } from './ui';
import { checkPassRate } from '../checkPassRate';

export interface MetricsTotals {
  events: number;
  closed: number;
  passes: number;
  fails: number;
  prsOpened: number;
}

interface MetricsCounts { events_count: number; items_closed: number; validate_passes: number; validate_fails: number; prs_opened?: number }

/**
 * The tiles' numbers from a /v1/metrics answer: its live `totals`, counted on
 * the per-person rows' rules (exact period start, each item closed once), so
 * the tiles agree with the rows (BUG 72c309df). Adding up the rollup series
 * would not: it counts UTC days, and an item once per day it closed. A hub
 * that predates `totals` (a rolling deploy) still gets the series' sum
 * rather than zeros.
 */
export function tileTotals(data: { series?: MetricsCounts[]; totals?: MetricsCounts } | undefined): MetricsTotals {
  const rows = data?.totals ? [data.totals] : (data?.series ?? []);
  return rows.reduce(
    (a, r) => ({
      events: a.events + r.events_count,
      closed: a.closed + r.items_closed,
      passes: a.passes + r.validate_passes,
      fails: a.fails + r.validate_fails,
      prsOpened: a.prsOpened + (r.prs_opened ?? 0),
    }),
    { events: 0, closed: 0, passes: 0, fails: 0, prsOpened: 0 },
  );
}

/** The event types each tile counts; an empty list means every type. */
const TILE_TYPES = {
  events: [] as string[],
  closed: ['item.closed'],
  rate: ['validate.passed', 'validate.failed'],
  prs: ['pr.opened'],
};

const TILE_ACTION: Record<keyof typeof TILE_TYPES, string> = {
  events: 'Show every event type below',
  closed: 'Show only item closed events below',
  rate: 'Show only check events below',
  prs: 'Show only PR opened events below',
};

const sameTypes = (sel: Set<string>, types: string[]) => sel.size === types.length && types.every(t => sel.has(t));

/**
 * The headline numbers. Each swatch is the timeline colour of the same event
 * type (chartColours.ts), so a tile and its series read as one thing.
 *
 * With `onFilterTypes`, each tile is also a filter: clicking it sets the Event
 * type selection to what it counts (shown pressed while that is the selection)
 * and clicking it again clears the selection. The totals themselves ignore the
 * event-type filter, so clicking changes the views below, never the tiles.
 */
export function MetricsTilesRow({ totals, selectedTypes, onFilterTypes }: {
  totals: MetricsTotals;
  selectedTypes?: Set<string>;
  onFilterTypes?: (types: string[]) => void;
}) {
  const filter = (key: keyof typeof TILE_TYPES) => {
    if (!onFilterTypes || !selectedTypes) return {};
    const pressed = sameTypes(selectedTypes, TILE_TYPES[key]);
    // "All types" pressed has nothing to release: it stays a button, locked.
    const locked = pressed && TILE_TYPES[key].length === 0;
    return { pressed, locked, description: locked ? 'Showing every event type' : TILE_ACTION[key], onClick: () => onFilterTypes(pressed ? [] : TILE_TYPES[key]) };
  };
  // One rate rather than two raw counts: "128 failed" means nothing without
  // the passes beside it. No checks at all is a dash, not 0%.
  const pct = checkPassRate(totals.passes, totals.fails);
  const checks = totals.passes + totals.fails;
  const rate = pct === null ? '—' : `${pct}%`;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile label="Events" value={totals.events} {...filter('events')} />
      <StatTile label="Items closed" value={totals.closed} series={1} {...filter('closed')} />
      <StatTile
        label="Check pass rate"
        value={rate}
        hint={checks === 0 ? 'no checks ran' : `${totals.passes.toLocaleString()} passed · ${totals.fails.toLocaleString()} failed`}
        {...filter('rate')}
      />
      <StatTile label="PRs opened" value={totals.prsOpened} series={4} {...filter('prs')} />
    </div>
  );
}
