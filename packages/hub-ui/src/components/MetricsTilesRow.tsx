import { StatTile } from './ui';

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
  const checks = totals.passes + totals.fails;
  // Rounding may not claim "nothing failed" or "nothing passed": 999/1000 is
  // 99%, not 100%, and 1/301 is 1%, not 0%.
  const pct = checks === 0 ? 0
    : Math.min(totals.fails > 0 ? 99 : 100, Math.max(totals.passes > 0 ? 1 : 0, Math.round((totals.passes / checks) * 100)));
  const rate = checks === 0 ? '—' : `${pct}%`;
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
