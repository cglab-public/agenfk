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
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <StatTile label="Events" value={totals.events} />
      <StatTile label="Items closed" value={totals.closed} series={1} />
      <StatTile label="Checks passed" value={totals.passes} series={5} />
      <StatTile label="Checks failed" value={totals.fails} series={6} />
      <StatTile label="PRs opened" value={totals.prsOpened} series={4} />
    </div>
  );
}
