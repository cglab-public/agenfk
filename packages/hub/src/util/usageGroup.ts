/**
 * GH-389 follow-up: the usage overview's aggregation. A UsageGroup sums the
 * usage payloads (UsageSummary: total + byModel) of the events it is given,
 * merging models by client + model and counting the distinct cards behind it.
 * GH-397: estimatedCostUsd (what the installation priced its turns at when it
 * ingested them) is summed like the rest; a payload from before has none: 0.
 */
export const USAGE_FIELDS = ['turns', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'costUsd', 'estimatedCostUsd', 'unpricedTurns'] as const;
export type UsageTotalsRow = Record<typeof USAGE_FIELDS[number], number>;
export type ModelRow = UsageTotalsRow & { client: string; model: string };
export const zeroTotals = (): UsageTotalsRow => ({ turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 0 });
/** Adds b into a. Payload numbers may arrive as strings (Postgres json): coerced, junk is 0. */
export function addTotals(a: UsageTotalsRow, b: any): void {
  for (const k of USAGE_FIELDS) { const v = Number(b?.[k]); if (Number.isFinite(v)) a[k] += v; }
}
export const tokenWeight = (t: UsageTotalsRow) => t.input + t.cacheRead + t.cacheWrite + t.output;

/** One breakdown row: its totals, its models (merged by client + model) and the cards behind it. */
export class UsageGroup {
  total = zeroTotals();
  private models = new Map<string, ModelRow>();
  private items = new Set<string>();
  add(itemId: string | null, usage: any): void {
    if (itemId) this.items.add(itemId);
    addTotals(this.total, usage?.total);
    for (const m of Array.isArray(usage?.byModel) ? usage.byModel : []) {
      const client = String(m?.client ?? 'unknown');
      const model = String(m?.model ?? 'unknown');
      const key = `${client}\u0000${model}`;
      let row = this.models.get(key);
      if (!row) { row = { client, model, ...zeroTotals() }; this.models.set(key, row); }
      addTotals(row, m);
    }
  }
  get cards(): number { return this.items.size; }
  byModel(): ModelRow[] { return [...this.models.values()].sort((a, b) => tokenWeight(b) - tokenWeight(a)); }
}

/** The installation's live identity, the same precedence the admin pages use. */
export function installationLabel(r: { git_name?: string | null; git_email?: string | null; os_user?: string | null } | undefined): string | null {
  if (!r) return null;
  if (r.git_name && r.git_email) return `${r.git_name} <${r.git_email}>`;
  return r.git_email || r.git_name || r.os_user || null;
}

export function chunks<T>(xs: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}


/** A usage payload's {byModel, total}: the totals are always the sum of the model rows. */
export interface Summary { total: UsageTotalsRow; byModel: ModelRow[] }
export function summaryFromModels(models: ModelRow[]): Summary {
  const total = zeroTotals();
  for (const m of models) addTotals(total, m);
  return { total, byModel: models };
}

const keyOf = (m: { client: string; model: string }) => `${m.client}\u0000${m.model}`;
/**
 * A usage payload's model rows, numbers coerced and one row per client + model.
 * A payload with a total but no model rows (none is sent so, but the hub does
 * not trust it) is one 'unknown' row, so the totals stay the rows' sum.
 */
export function modelsOf(usage: any): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const m of Array.isArray(usage?.byModel) ? usage.byModel : []) {
    const row: ModelRow = { client: String(m?.client ?? 'unknown'), model: String(m?.model ?? 'unknown'), ...zeroTotals() };
    const had = rows.get(keyOf(row));
    addTotals(had ?? row, m);
    if (!had) rows.set(keyOf(row), row);
  }
  if (rows.size === 0) {
    const t = zeroTotals();
    addTotals(t, usage?.total);
    if (USAGE_FIELDS.some(k => t[k] > 0)) rows.set('unknown', { client: 'unknown', model: 'unknown', ...t });
  }
  return [...rows.values()];
}

/**
 * One card's usage as the hub has recorded it, per model and field. A step from
 * an older version is a delta: all of it is new. A cumulative snapshot
 * (usage.own, on every step and close since) credits only what it has beyond
 * the record, so a turn is counted once however late it was read, in whatever
 * order the events arrive, and across reopens.
 *
 * A snapshot BELOW the previous one means the installation's database went
 * back (a restored backup): the gap is carried as an offset, so the spend
 * after the restore is credited and the restored history is not counted again.
 * What was spent between the restore and the first snapshot after it cannot be
 * told from the restored part without a restore marker from the client, and is
 * not credited.
 */
export class CardLedger {
  /** Per model and field: credited so far, the last (offset) snapshot, and the offset. */
  private state = new Map<string, { credited: UsageTotalsRow; last: UsageTotalsRow; offset: UsageTotalsRow }>();
  private of(m: ModelRow) {
    let st = this.state.get(keyOf(m));
    if (!st) { st = { credited: zeroTotals(), last: zeroTotals(), offset: zeroTotals() }; this.state.set(keyOf(m), st); }
    return st;
  }
  addDelta(models: ModelRow[]): ModelRow[] {
    for (const m of models) {
      const st = this.of(m);
      for (const k of USAGE_FIELDS) { st.credited[k] += m[k]; st.last[k] += m[k]; }
    }
    return models;
  }
  addSnapshot(models: ModelRow[]): ModelRow[] {
    const credits: ModelRow[] = [];
    for (const m of models) {
      const st = this.of(m);
      const credit: ModelRow = { client: m.client, model: m.model, ...zeroTotals() };
      for (const k of USAGE_FIELDS) {
        let adjusted = m[k] + st.offset[k];
        if (adjusted < st.last[k]) { st.offset[k] += st.last[k] - adjusted; adjusted = st.last[k]; }
        credit[k] = Math.max(0, adjusted - st.credited[k]);
        st.credited[k] = Math.max(st.credited[k], adjusted);
        st.last[k] = adjusted;
      }
      if (USAGE_FIELDS.some(k => credit[k] > 0)) credits.push(credit);
    }
    return credits;
  }
}
