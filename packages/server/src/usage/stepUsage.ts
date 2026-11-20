import { estimateCost, fallbackPricesLabel, type CardUsage, type ModelUsage, type PricesData, type StepUsage, type TokenEvent, type UsageSummary, type UsageTotals } from '@agenfk/core';

/**
 * GH-389: a card's token usage, per step it left.
 *
 * Usage is summed from the turns ingested from the harnesses' session logs and
 * attributed to the card (token-ingestion). Cost is what a harness reported
 * itself (pi, `costUsd`) and, apart, what this server priced the other turns
 * at when it ingested them (`estimatedCostUsd`, GH-397). A turn with neither
 * is counted in `unpricedTurns`, so a total never passes a partial cost off as
 * complete; the board or hub prices those at today's prices, saying so.
 */

export const zeroTotals = (): UsageTotals => ({
  turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 0,
});

/** Add `b` into `a`. A `b` recorded before GH-397 has no estimatedCostUsd: 0. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  a.turns += b.turns;
  a.input += b.input;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.output += b.output;
  a.reasoning += b.reasoning;
  a.costUsd += b.costUsd;
  a.estimatedCostUsd = (a.estimatedCostUsd || 0) + (b.estimatedCostUsd || 0);
  a.unpricedTurns += b.unpricedTurns;
  return a;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One turn's totals; ingestion prices a turn from exactly these tokens. */
export function totalsOf(ev: TokenEvent): UsageTotals {
  // Codex reports cache reads only, as cachedInput with no split.
  const split = ev.cacheRead !== undefined || ev.cacheWrite !== undefined;
  const priced = finite(ev.costUsd);
  const estimated = !priced && finite(ev.estimatedCostUsd);
  return {
    turns: 1,
    input: ev.input,
    cacheRead: split ? ev.cacheRead ?? 0 : ev.cachedInput,
    cacheWrite: split ? ev.cacheWrite ?? 0 : 0,
    output: ev.output,
    reasoning: ev.reasoning,
    costUsd: priced ? ev.costUsd! : 0,
    estimatedCostUsd: estimated ? ev.estimatedCostUsd! : 0,
    unpricedTurns: priced || estimated ? 0 : 1,
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

/**
 * When the card's stay in `step` began. Every move records a usage row, so the
 * latest row - when it is the move INTO this step - ends exactly where this
 * stay begins: the two windows meet at one instant and no turn is counted in
 * both (review finding: the history timestamp is written a moment before the
 * row's end, and using it double-counted turns in between). With no such row
 * (a move from before usage existed, or a write that bypassed the workflow),
 * the latest history entry into the step, else the card's creation.
 */
function enteredAt(
  item: { createdAt: unknown; history?: Array<{ toStatus: unknown; timestamp: unknown }>; usageByStep?: Array<{ to: string; leftAt: string }> },
  step: string,
  at: string,
): string {
  const rows = item.usageByStep ?? [];
  const last = rows[rows.length - 1];
  if (last && last.to === step && Date.parse(last.leftAt) <= Date.parse(at)) return last.leftAt;
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
  item: { id: string; createdAt: unknown; history?: Array<{ toStatus: unknown; timestamp: unknown }>; usageByStep?: Array<{ to: string; leftAt: string }> };
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
/**
 * The card's own usage to date, from its stored turns (its descendants' not
 * included). Every step.transitioned carries it, so the hub can add a card up
 * from cumulative snapshots: a turn ingested after its step was counted is in
 * the next snapshot, and a snapshot never counts a turn twice.
 */
export async function computeOwnUsage(
  storage: { queryTokenEvents(q: { itemId: string }): Promise<TokenEvent[]> },
  itemId: string,
): Promise<UsageSummary & { asOf: string }> {
  // Stamped before the read: the snapshot holds at least every turn stored by then.
  const asOf = new Date().toISOString();
  return { ...aggregateUsage(await storage.queryTokenEvents({ itemId })), asOf };
}

export async function computeCardUsage(
  storage: {
    getItem(id: string): Promise<any>;
    listItems(q: { projectId: string }): Promise<any[]>;
    queryTokenEvents(q: { itemId: string }): Promise<TokenEvent[]>;
  },
  itemId: string,
  /** False when the closing step's logs could not be read in time: later turns may be missing. */
  complete = true,
  /** The closing step's row, not stored yet: it is saved with the move itself. */
  pendingStep?: StepUsage | null,
  /** The step the card closes in. */
  atStatus?: string,
): Promise<CardUsage | null> {
  const item = await storage.getItem(itemId);
  if (!item) return null;
  const all = await storage.listItems({ projectId: item.projectId });
  const ids = [item.id];
  for (let i = 0; i < ids.length; i++) {
    for (const child of all) if (child.parentId === ids[i] && !ids.includes(child.id)) ids.push(child.id);
  }
  const events: TokenEvent[] = [];
  let ownCount = 0;
  const asOf = new Date().toISOString();
  for (const id of ids) {
    events.push(...await storage.queryTokenEvents({ itemId: id }));
    if (id === item.id) ownCount = events.length;
  }
  const rows = [...((item.usageByStep ?? []) as StepUsage[]), ...(pendingStep ? [pendingStep] : [])];
  const byStep = rows.map((u) => ({ step: u.step, total: u.total }));
  // A descendant that closed with turns missing makes this total incomplete too (review finding).
  const descendantsComplete = all
    .filter((c: any) => ids.includes(c.id) && c.id !== item.id)
    .every((c: any) => c.cardUsage?.complete !== false);
  return {
    ...aggregateUsage(events), byStep, cards: ids.length,
    // The card's own turns, without its descendants': the hub sums cards one
    // by one, and a parent's whole total would count its children again.
    // asOf orders a card's snapshots on the hub (by read, not by emission).
    own: { ...aggregateUsage(events.slice(0, ownCount)), asOf },
    complete: complete && descendantsComplete,
    ...(atStatus ? { atStatus } : {}),
  };
}

const n = (v: number) => v.toLocaleString('en-US');

/**
 * `today` is the estimate at today's prices of the models whose turns all lack
 * a price (older usage), from the price table the server has at hand; it is
 * shown, never stored.
 */
function describeTotals(head: string, t: UsageTotals, complete: boolean, today = 0, todayLabel = "today's prices"): string {
  const tail = complete ? '' : ' (incomplete: the session logs could not be read in time)';
  if (t.turns === 0) return `${head} no usage recorded${tail}.`;
  const parts = [
    `${n(t.turns)} turn${t.turns === 1 ? '' : 's'}`,
    `${n(t.input)} input`,
    `${n(t.cacheRead)} cache read`,
    `${n(t.cacheWrite)} cache write`,
    `${n(t.output)} output`,
  ];
  const costs = [
    { usd: t.costUsd || 0, label: 'reported' },
    { usd: t.estimatedCostUsd || 0, label: 'est. when used' },
    { usd: today, label: `est. at ${todayLabel}` },
  ].filter((c) => c.usd > 0);
  const usd = (v: number) => `$${v.toFixed(2)}`;
  if (costs.length === 1) parts.push(`${usd(costs[0].usd)} ${costs[0].label}`);
  else if (costs.length > 1) {
    const sum = costs.reduce((a, c) => a + c.usd, 0);
    parts.push(`${usd(sum)} cost (${costs.map((c) => `${usd(c.usd)} ${c.label}`).join(' + ')})`);
  }
  if (t.unpricedTurns > 0) parts.push(`${n(t.unpricedTurns)} turn${t.unpricedTurns === 1 ? '' : 's'} unpriced`);
  return `${head} ${parts.join(', ')}${tail}.`;
}

const todayOf = (u: UsageSummary, prices: PricesData | null | undefined) => (prices ? estimateCost(u.byModel ?? [], prices).estimatedToday : 0);

/** One line for a verify reply; `prices` estimates older unpriced turns at today's prices. */
export function describeUsage(u: StepUsage, prices?: PricesData | null): string {
  return describeTotals(`📊 Usage in ${u.step}:`, u.total, u.complete, todayOf(u, prices), fallbackPricesLabel(prices));
}

/** The DONE reply's line for the whole card. */
export function describeCardUsage(u: CardUsage, prices?: PricesData | null): string {
  const scope = u.cards > 1 ? ` (with ${u.cards - 1} sub-card${u.cards === 2 ? '' : 's'})` : '';
  return describeTotals(`📊 Card usage${scope}:`, u.total, u.complete !== false, todayOf(u, prices), fallbackPricesLabel(prices));
}
