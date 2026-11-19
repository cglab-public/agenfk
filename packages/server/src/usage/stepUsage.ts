import type { CardUsage, ModelUsage, StepUsage, TokenEvent, UsageSummary, UsageTotals } from '@agenfk/core';

/**
 * GH-389: a card's token usage, per step it left.
 *
 * Usage is summed from the turns ingested from the harnesses' session logs and
 * attributed to the card (token-ingestion). Cost is only what a harness
 * reported itself (pi): this server never prices a turn, because that needs a
 * live price table from the internet. A turn without a reported cost is
 * counted in `unpricedTurns`, so a total never passes a partial cost off as
 * complete, and the board or hub prices those from the model and tokens.
 */

export const zeroTotals = (): UsageTotals => ({
  turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0,
});

/** Add `b` into `a`. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
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

function totalsOf(ev: TokenEvent): UsageTotals {
  // Codex reports cache reads only, as cachedInput with no split.
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

/** Sum turns per (client, model) and in total, models in order of first appearance. */
export function aggregateUsage(events: TokenEvent[]): UsageSummary {
  const byKey = new Map<string, ModelUsage>();
  const total = zeroTotals();
  for (const ev of events) {
    const t = totalsOf(ev);
    const key = `${ev.client}\u0000${ev.model}`;
    let row = byKey.get(key);
    if (!row) {
      row = { client: ev.client, model: ev.model, ...zeroTotals() };
      byKey.set(key, row);
    }
    addTotals(row, t);
    addTotals(total, t);
  }
  return { byModel: [...byKey.values()], total };
}

interface StepUsageDeps {
  storage: {
    sessionsForItem(itemId: string): Promise<Array<{ client: string; sessionId: string }>>;
    queryTokenEvents(q: { itemId: string; since: string; until: string }): Promise<TokenEvent[]>;
  };
  /** Ingest these sessions' logs now (usage ingestion's flush). */
  flush(sessions: Array<{ client: string; sessionId: string }>): Promise<unknown>;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;

/** When the card last entered `step` at or before `at`: the latest history entry into it, else its creation. */
function enteredAt(item: { createdAt: unknown; history?: Array<{ toStatus: unknown; timestamp: unknown }> }, step: string, at: string): string {
  const atMs = Date.parse(at);
  let best: number | null = null;
  for (const h of item.history ?? []) {
    if (String(h.toStatus) !== step) continue;
    const t = new Date(h.timestamp as any).getTime();
    if (Number.isFinite(t) && t <= atMs && (best === null || t > best)) best = t;
  }
  return new Date(best ?? new Date(item.createdAt as any).getTime()).toISOString();
}

/**
 * The usage of the stay in `from` that ends at `at`: the card's turns since it
 * last entered `from`, after flushing the logs of every session that worked
 * on the card so the last turns are in. A flush that fails or runs past
 * `flushTimeoutMs` never holds the move: what is already ingested is counted
 * and the result says it may be incomplete.
 */
export async function computeStepUsage(args: StepUsageDeps & {
  item: { id: string; createdAt: unknown; history?: Array<{ toStatus: unknown; timestamp: unknown }> };
  from: string;
  to: string;
  at: string;
  flushTimeoutMs?: number;
}): Promise<StepUsage> {
  const { storage, item, from, to, at } = args;
  let complete = true;
  try {
    const sessions = await storage.sessionsForItem(item.id);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), args.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([args.flush(sessions).then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') complete = false;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    complete = false;
    console.error(`[USAGE] could not flush the session logs of ${item.id}: ${(e as Error).message}`);
  }
  const since = enteredAt(item, from, at);
  const events = await storage.queryTokenEvents({ itemId: item.id, since, until: at });
  return { step: from, to, enteredAt: since, leftAt: at, complete, ...aggregateUsage(events) };
}

/**
 * A card's usage at close: every turn charged to the card or to any of its
 * descendants, read from the stored turns (not added up from step rows, so a
 * turn ingested after its step was counted is not lost), broken down by the
 * card's own steps.
 */
export async function computeCardUsage(
  storage: {
    getItem(id: string): Promise<any>;
    listItems(q: { projectId: string }): Promise<any[]>;
    queryTokenEvents(q: { itemId: string }): Promise<TokenEvent[]>;
  },
  itemId: string,
): Promise<CardUsage | null> {
  const item = await storage.getItem(itemId);
  if (!item) return null;
  const all = await storage.listItems({ projectId: item.projectId });
  const ids = [item.id];
  for (let i = 0; i < ids.length; i++) {
    for (const child of all) if (child.parentId === ids[i] && !ids.includes(child.id)) ids.push(child.id);
  }
  const events: TokenEvent[] = [];
  for (const id of ids) events.push(...await storage.queryTokenEvents({ itemId: id }));
  const byStep = ((item.usageByStep ?? []) as StepUsage[]).map((u) => ({ step: u.step, total: u.total }));
  return { ...aggregateUsage(events), byStep, cards: ids.length };
}

const n = (v: number) => v.toLocaleString('en-US');

function describeTotals(head: string, t: UsageTotals, complete: boolean): string {
  const tail = complete ? '' : ' (incomplete: the session logs could not be read in time)';
  if (t.turns === 0) return `${head} no usage recorded${tail}.`;
  const parts = [
    `${n(t.turns)} turn${t.turns === 1 ? '' : 's'}`,
    `${n(t.input)} input`,
    `${n(t.cacheRead)} cache read`,
    `${n(t.cacheWrite)} cache write`,
    `${n(t.output)} output`,
  ];
  if (t.costUsd > 0) parts.push(`$${t.costUsd.toFixed(2)} reported`);
  if (t.unpricedTurns > 0) parts.push(`${n(t.unpricedTurns)} turn${t.unpricedTurns === 1 ? '' : 's'} unpriced`);
  return `${head} ${parts.join(', ')}${tail}.`;
}

/** One line for a verify reply. */
export function describeUsage(u: StepUsage): string {
  return describeTotals(`📊 Usage in ${u.step}:`, u.total, u.complete);
}

/** The DONE reply's line for the whole card. */
export function describeCardUsage(u: CardUsage): string {
  const scope = u.cards > 1 ? ` (with ${u.cards - 1} sub-card${u.cards === 2 ? '' : 's'})` : '';
  return describeTotals(`📊 Card usage${scope}:`, u.total, true);
}
