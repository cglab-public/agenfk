// Pure aggregation helper for /v1/histogram. Extracted for direct unit testing
// because pg-mem (used in dual-backend parity tests) auto-coerces COUNT(*) to
// numbers, while real Postgres returns bigints as strings — the prod shape
// that produced bug 307a9fbe (string concatenation instead of integer sum).
//
// Coerces every n via Number() so the response carries real JS numbers
// regardless of which DB driver delivered the rows.

export interface HistogramRow {
  time: string;
  type: string;
  n: number | string;
}

export interface HistogramBucket {
  time: string;
  total: number;
  by_type: Record<string, number>;
}

export function aggregateHistogramRows(rows: HistogramRow[]): HistogramBucket[] {
  const byTime = new Map<string, HistogramBucket>();
  for (const r of rows) {
    let entry = byTime.get(r.time);
    if (!entry) {
      entry = { time: r.time, total: 0, by_type: {} };
      byTime.set(r.time, entry);
    }
    const n = Number(r.n);
    entry.by_type[r.type] = n;
    entry.total += n;
  }
  return [...byTime.values()];
}
