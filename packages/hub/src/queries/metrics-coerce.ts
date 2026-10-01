// Pure coercion helper for /v1/metrics. Postgres returns bigint COUNT/SUM as
// JS strings; the hub-ui then does `acc + r.events_count` and concatenates
// instead of summing — visible as "078113"/"0401" in the dashboard tiles.
// Same shape as histogram-aggregate.ts for the prior bug (307a9fbe).

const NUMERIC_COLS = [
  'events_count', 'items_closed',
  'tokens_in', 'tokens_out',
  'validate_passes', 'validate_fails',
  'prs_opened',
] as const;

type NumericCol = typeof NUMERIC_COLS[number];

export interface MetricsRowOut {
  user_key: string;
  day: string;
  events_count: number;
  items_closed: number;
  tokens_in: number;
  tokens_out: number;
  validate_passes: number;
  validate_fails: number;
  prs_opened: number;
}

function toInt(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function coerceMetricsRow(row: Record<string, unknown>): MetricsRowOut {
  const out: any = { user_key: row.user_key, day: row.day };
  for (const c of NUMERIC_COLS as readonly NumericCol[]) {
    out[c] = toInt(row[c]);
  }
  return out;
}

export interface MetricsTotalsOut {
  events_count: number;
  items_closed: number;
  validate_passes: number;
  validate_fails: number;
  prs_opened: number;
}

/** The period's live totals (BUG 72c309df); SUM over no rows is NULL → 0. */
export function coerceMetricsTotals(row: Record<string, unknown> | undefined): MetricsTotalsOut {
  return {
    events_count: toInt(row?.events_count),
    items_closed: toInt(row?.items_closed),
    validate_passes: toInt(row?.validate_passes),
    validate_fails: toInt(row?.validate_fails),
    prs_opened: toInt(row?.prs_opened),
  };
}
