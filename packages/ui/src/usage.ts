/**
 * GH-389: a card's AI usage as the board shows it.
 *
 * The server records the usage of each step when the card leaves it
 * (usageByStep) and the whole card's when it closes (cardUsage, sub-cards
 * included). The step the card is in now has no row yet, so it is counted
 * live from the turns ingested since the card entered it.
 *
 * Cost: harnesses that price their own turns (pi) report it; for the rest the
 * board can only ESTIMATE, from its price table, and says so.
 */
import type { AgEnFKItem, ModelUsage, TokenEvent, UsageTotals } from './types';
import { getModelPrice } from './utils';

export const zeroTotals = (): UsageTotals => ({
  turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0,
});

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  a.turns += b.turns;
  a.input += b.input;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.output += b.output;
  a.reasoning += b.reasoning;
  a.costUsd += b.costUsd;
  a.unpricedTurns += b.unpricedTurns;
  return a;
}

function totalsOfEvent(ev: TokenEvent): UsageTotals {
  const split = ev.cacheRead !== undefined || ev.cacheWrite !== undefined;
  const priced = typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd);
  return {
    turns: 1,
    input: ev.input,
    cacheRead: split ? ev.cacheRead ?? 0 : ev.cachedInput,
    cacheWrite: split ? ev.cacheWrite ?? 0 : 0,
    output: ev.output,
    reasoning: ev.reasoning,
    costUsd: priced ? ev.costUsd! : 0,
    unpricedTurns: priced ? 0 : 1,
  };
}

class ModelBuckets {
  private rows = new Map<string, ModelUsage>();
  add(client: string, model: string, t: UsageTotals): void {
    const key = `${client}\u0000${model}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { client, model, ...zeroTotals() };
      this.rows.set(key, row);
    }
    add(row, t);
  }
  list(): ModelUsage[] { return [...this.rows.values()]; }
}

/** When the card entered the step it is in now: its latest move there, else its creation. */
export function currentStepSince(item: Pick<AgEnFKItem, 'status' | 'history' | 'createdAt'>): string | null {
  let best: number | null = null;
  for (const h of item.history ?? []) {
    if (String(h.toStatus) !== String(item.status)) continue;
    const t = new Date(h.timestamp as string | number | Date).getTime();
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  if (best === null) {
    const created = new Date(item.createdAt as string | number | Date).getTime();
    if (!Number.isFinite(created)) return null;
    best = created;
  }
  return new Date(best).toISOString();
}

export interface UsageRow {
  step: string;
  /** The step the card is in now, counted from its turns so far. */
  live: boolean;
  total: UsageTotals;
}

export interface CardUsageSummary {
  steps: UsageRow[];
  byModel: ModelUsage[];
  total: UsageTotals;
  /** Sub-cards the total includes (a closed parent's). */
  subCards: number;
  /** False when not a single turn was recorded: "not measured", not zero. */
  measured: boolean;
}

/**
 * The card's usage: its recorded steps, then the current step from `liveEvents`.
 * A closed card's total is the one recorded at close, which includes its
 * sub-cards; until then it is the steps plus the current one.
 */
export function summarizeCardUsage(
  item: Pick<AgEnFKItem, 'status' | 'usageByStep' | 'cardUsage'> & Partial<Pick<AgEnFKItem, 'history' | 'createdAt'>>,
  liveEvents: TokenEvent[],
): CardUsageSummary {
  const models = new ModelBuckets();
  const total = zeroTotals();
  const steps: UsageRow[] = (item.usageByStep ?? []).map((u) => {
    for (const m of u.byModel ?? []) models.add(m.client, m.model, m);
    add(total, u.total);
    return { step: u.step, live: false, total: u.total };
  });

  if (!item.cardUsage && liveEvents.length) {
    const now = zeroTotals();
    for (const ev of liveEvents) {
      const t = totalsOfEvent(ev);
      models.add(ev.client, ev.model, t);
      add(now, t);
    }
    add(total, now);
    steps.push({ step: String(item.status), live: true, total: now });
  }

  if (item.cardUsage) {
    return {
      steps,
      byModel: item.cardUsage.byModel,
      total: item.cardUsage.total,
      subCards: Math.max(0, item.cardUsage.cards - 1),
      measured: item.cardUsage.total.turns > 0,
    };
  }
  return { steps, byModel: models.list(), total, subCards: 0, measured: total.turns > 0 };
}

export interface CostView {
  /** What the harnesses reported, in USD. */
  reported: number;
  /** The board's estimate for models none of whose turns were priced. */
  estimated: number;
  /** Models with unpriced turns the board could not estimate. */
  unpricedModels: string[];
}

/**
 * Cost per model: what was reported, plus an estimate from the board's price
 * table (USD per million tokens) for a model NONE of whose turns were priced.
 * Cache reads at the table's cached-input rate (else the input rate), cache
 * writes at the input rate - an estimate, labelled as one wherever it shows.
 */
/** One row of the board's price table (USD per million tokens). */
export interface PriceEntry {
  id: string;
  input?: number;
  output?: number;
  input_cached?: number;
}

export interface PricesData {
  prices?: PriceEntry[];
}

export function estimateCost(byModel: ModelUsage[], pricesData: PricesData | null | undefined): CostView {
  const view: CostView = { reported: 0, estimated: 0, unpricedModels: [] };
  for (const m of byModel) {
    view.reported += m.costUsd;
    if (m.unpricedTurns === 0) continue;
    const price = m.unpricedTurns === m.turns && pricesData?.prices ? getModelPrice(m.model, pricesData.prices) : null;
    if (!price) {
      view.unpricedModels.push(m.model);
      continue;
    }
    const input = Number(price.input) || 0;
    const cached = Number(price.input_cached ?? price.input) || 0;
    view.estimated += (m.input * input + m.output * (Number(price.output) || 0) + m.cacheRead * cached + m.cacheWrite * input) / 1_000_000;
  }
  return view;
}

export const tokensOf = (t: UsageTotals): number => t.input + t.cacheRead + t.cacheWrite + t.output;

/** 950, 42k, 3.7M: the size of a total at a glance. */
export function abbreviateTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
