import { StatTile } from './ui';
import { checkPassRate } from '../checkPassRate';

export interface MetricsTotals {
  events: number;
  closed: number;
  passes: number;
  fails: number;
  prsOpened: number;
}

/**
 * The headline numbers. Each swatch is the timeline colour of the same event
 * type (chartColours.ts), so a tile and its series read as one thing.
 */
export function MetricsTilesRow({ totals }: { totals: MetricsTotals }) {
  // One rate rather than two raw counts: "128 failed" means nothing without
  // the passes beside it. No checks at all is a dash, not 0%.
  const pct = checkPassRate(totals.passes, totals.fails);
  const checks = totals.passes + totals.fails;
  const rate = pct === null ? '—' : `${pct}%`;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile label="Events" value={totals.events} />
      <StatTile label="Items closed" value={totals.closed} series={1} />
      <StatTile
        label="Check pass rate"
        value={rate}
        hint={checks === 0 ? 'no checks ran' : `${totals.passes.toLocaleString()} passed · ${totals.fails.toLocaleString()} failed`}
      />
      <StatTile label="PRs opened" value={totals.prsOpened} series={4} />
    </div>
  );
}
