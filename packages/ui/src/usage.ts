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

/**
 * When the card's stay in its current step began: where the last recorded
 * step ended when that was the move into this step (so the live count starts
 * exactly where the recorded rows stop), else its latest move there, else its
 * creation.
 */
export function currentStepSince(item: Pick<AgEnFKItem, 'status' | 'history' | 'createdAt' | 'usageByStep'>): string | null {
  const rows = item.usageByStep ?? [];
  const last = rows[rows.length - 1];
  if (last && last.to === String(item.status) && Number.isFinite(Date.parse(last.leftAt))) return last.leftAt;
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
  /** False when the step's session logs could not be read in time: turns may be missing. */
  complete: boolean;
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
  /** False when some turns may be missing (a log that could not be read in time). */
  complete: boolean;
}

/**
 * The total recorded when the card closed, while it still describes the card:
 * a card reopened by any route is no longer in the step it closed in.
 */
export function closeTotalOf(item: Pick<AgEnFKItem, 'status' | 'cardUsage'>): AgEnFKItem['cardUsage'] | null {
  const card = item.cardUsage;
  return card && card.atStatus === String(item.status) ? card : null;
}

/**
 * The card's usage: its recorded steps, then the current step from `liveEvents`.
 * A closed card's total is the one recorded at close, which includes its
 * sub-cards; otherwise it is the steps plus the current one.
 */
export function summarizeCardUsage(
  item: Pick<AgEnFKItem, 'status' | 'usageByStep' | 'cardUsage'> & Partial<Pick<AgEnFKItem, 'history' | 'createdAt'>>,
  liveEvents: TokenEvent[],
): CardUsageSummary {
  const closed = closeTotalOf(item);
  const models = new ModelBuckets();
  const total = zeroTotals();
  const steps: UsageRow[] = (item.usageByStep ?? []).map((u) => {
    for (const m of u.byModel ?? []) models.add(m.client, m.model, m);
    add(total, u.total);
    return { step: u.step, live: false, complete: u.complete !== false, total: u.total };
  });

  if (!closed && liveEvents.length) {
    const now = zeroTotals();
    for (const ev of liveEvents) {
      const t = totalsOfEvent(ev);
      models.add(ev.client, ev.model, t);
      add(now, t);
    }
    add(total, now);
    steps.push({ step: String(item.status), live: true, complete: true, total: now });
  }

  const stepsComplete = steps.every((r) => r.complete);
  if (closed) {
    return {
      steps,
      byModel: closed.byModel,
      total: closed.total,
      subCards: Math.max(0, closed.cards - 1),
      measured: closed.total.turns > 0,
      complete: closed.complete !== false && stepsComplete,
    };
  }
  return { steps, byModel: models.list(), total, subCards: 0, measured: total.turns > 0, complete: stepsComplete };
}

// The estimator is shared with the hub's /usage page (GH-389): one copy.
export { estimateCost, type CostView, type PriceEntry, type PricesData } from '@agenfk/flow-editor';

export const tokensOf = (t: UsageTotals): number => t.input + t.cacheRead + t.cacheWrite + t.output;

/** 950, 42k, 3.7M: the size of a total at a glance. */
export function abbreviateTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A card's total as the board knows it: its close total while current, else its recorded steps. */
export function cardTotalOf(item: Pick<AgEnFKItem, 'status' | 'usageByStep' | 'cardUsage'>): UsageTotals {
  const closed = closeTotalOf(item);
  if (closed) return closed.total;
  const total = zeroTotals();
  for (const r of item.usageByStep ?? []) add(total, r.total);
  return total;
}

export type TokenKind = 'input' | 'cacheRead' | 'cacheWrite' | 'output';
export const TOKEN_KINDS: Array<{ kind: TokenKind; label: string }> = [
  { kind: 'input', label: 'Input' },
  { kind: 'cacheRead', label: 'Cache read' },
  { kind: 'cacheWrite', label: 'Cache write' },
  { kind: 'output', label: 'Output' },
];

/** The four token kinds with their share of the total, largest first. */
export function tokenMix(t: UsageTotals): Array<{ kind: TokenKind; label: string; value: number; share: number }> {
  const all = tokensOf(t);
  return TOKEN_KINDS
    .map(({ kind, label }) => ({ kind, label, value: t[kind], share: all ? t[kind] / all : 0 }))
    .sort((a, b) => b.value - a.value);
}
