/**
 * GH-389 / GH-397: what AI usage cost, priced the same way everywhere: by the
 * local server when it ingests a turn (stored as estimatedCostUsd), and by the
 * board (packages/ui) and the hub's /usage page (packages/hub-ui) when they add
 * the stored prices up. Free of imports so the browser bundles can take this
 * file as it is (packages/flow-editor re-exports it).
 *
 * Harnesses that price their own turns (pi) report it (costUsd). For the rest
 * the cost is ESTIMATED from a public price table, and labelled so: when the
 * turn is ingested, or - for usage recorded before turns were priced - at
 * today's prices, labelled as such.
 */

/** Where the price table comes from (USD per million tokens). */
export const PRICES_URL = 'https://www.llm-prices.com/current-v1.json';

/** One model's usage, as far as pricing needs it. */
export interface PricedModelUsage {
  model: string;
  turns: number;
  unpricedTurns: number;
  costUsd: number;
  /** What AgEnFK priced the turns at when they were ingested; absent before GH-397. */
  estimatedCostUsd?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostView {
  /** What the harnesses reported, in USD. */
  reported: number;
  /** AgEnFK's estimates: estimatedAtTurn + estimatedToday. */
  estimated: number;
  /** Priced when the turns were ingested, from the table as it was then. */
  estimatedAtTurn: number;
  /** Older turns with no stored price, priced from today's table. */
  estimatedToday: number;
  /** Models with turns that could not be priced at all. */
  unpricedModels: string[];
  /** Models whose cost is (partly) AgEnFK's estimate. */
  estimatedModels: string[];
  /** Models (partly) priced at today's prices. */
  todayModels: string[];
}

/** One row of the price table (USD per million tokens). */
export interface PriceEntry {
  id: string;
  input?: number;
  output?: number;
  input_cached?: number | null;
}

export interface PricesData {
  prices?: PriceEntry[];
  /** When the table was fetched, where that is known (the local server's copy). */
  fetchedAt?: string;
}

/** The tokens of a turn, or of several, as they are priced. */
export interface PricedTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The public price table as the estimator may use it: only rows with a string
 * id and finite, non-negative rates. The table is a third party's JSON; a
 * malformed one must leave the page on reported cost, never throw or misprice.
 */
export function parsePrices(json: unknown): PricesData {
  const rows = (json as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(rows)) return { prices: [] };
  const rate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  // input and output are needed to price a turn at all (a row without them would
  // price a model at $0 silently); the cached rate is optional (the public table
  // writes null for none) and falls back to input. A blank id would match every
  // model in the fuzzy lookup.
  const prices = rows.filter((r): r is PriceEntry => {
    if (!r || typeof r !== 'object') return false;
    const e = r as PriceEntry;
    return typeof e.id === 'string' && e.id.trim() !== '' && rate(e.input) && rate(e.output)
      && (e.input_cached === undefined || e.input_cached === null || rate(e.input_cached));
  });
  return { prices };
}

/** USD for these tokens at this row's rates: cache reads at the cached rate (else input), cache writes at the input rate. */
function costAt(price: PriceEntry, t: PricedTokens): number {
  const input = Number(price.input) || 0;
  const cached = Number(price.input_cached ?? price.input) || 0;
  return (t.input * input + t.output * (Number(price.output) || 0) + t.cacheRead * cached + t.cacheWrite * input) / 1_000_000;
}

/** What these tokens of `model` cost at the table's rates; null when the table has no price for the model. */
export function priceTokens(model: string, t: PricedTokens, pricesData: PricesData | null | undefined): number | null {
  const price = pricesData?.prices ? getModelPrice(model, pricesData.prices) : null;
  return price ? costAt(price, t) : null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Cost per model: what was reported, plus what AgEnFK priced the turns at when
 * it ingested them, plus - for a model NONE of whose turns has either (older
 * usage) - an estimate of its tokens at today's prices. A model with only some
 * turns unpriced is named as not priced: a total does not say which of its
 * tokens those turns used, so their cost cannot be told from it.
 */
export function estimateCost(byModel: PricedModelUsage[], pricesData: PricesData | null | undefined): CostView {
  const view: CostView = { reported: 0, estimated: 0, estimatedAtTurn: 0, estimatedToday: 0, unpricedModels: [], estimatedModels: [], todayModels: [] };
  const named = (list: string[], model: string) => { if (!list.includes(model)) list.push(model); };
  for (const m of byModel) {
    view.reported += num(m.costUsd);
    const atTurn = num(m.estimatedCostUsd);
    if (atTurn > 0) {
      view.estimatedAtTurn += atTurn;
      named(view.estimatedModels, m.model);
    }
    const unpriced = num(m.unpricedTurns);
    if (unpriced <= 0) continue;
    const today = unpriced >= num(m.turns)
      ? priceTokens(m.model, { input: num(m.input), output: num(m.output), cacheRead: num(m.cacheRead), cacheWrite: num(m.cacheWrite) }, pricesData)
      : null;
    if (today === null) {
      named(view.unpricedModels, m.model);
      continue;
    }
    view.estimatedToday += today;
    named(view.estimatedModels, m.model);
    named(view.todayModels, m.model);
  }
  view.estimated = view.estimatedAtTurn + view.estimatedToday;
  return view;
}

const STALE_PRICES_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The rates older usage is priced at, named: today's, or - when the table is
 * a last good one from more than two days ago (it could not be refreshed) -
 * the day it was fetched.
 */
export function fallbackPricesLabel(prices: PricesData | null | undefined, now = Date.now()): string {
  const at = Date.parse(prices?.fetchedAt ?? '');
  if (!Number.isFinite(at) || now - at <= STALE_PRICES_MS) return "today's prices";
  return `prices of ${new Date(at).toISOString().slice(0, 10)}`;
}

/** Everything the usage cost, estimates included. */
export const costTotal = (c: CostView): number => c.reported + c.estimated;

/** Two costs as one: every part added, each model named once. */
export function addCostViews(a: CostView, b: CostView): CostView {
  const merge = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    reported: a.reported + b.reported,
    estimated: a.estimated + b.estimated,
    estimatedAtTurn: a.estimatedAtTurn + b.estimatedAtTurn,
    estimatedToday: a.estimatedToday + b.estimatedToday,
    unpricedModels: merge(a.unpricedModels, b.unpricedModels),
    estimatedModels: merge(a.estimatedModels, b.estimatedModels),
    todayModels: merge(a.todayModels, b.todayModels),
  };
}

/**
 * The ids a model may be listed under, most exact first: as given, without a
 * provider prefix (anthropic/..., us.anthropic....) or runtime suffix (-v1:0),
 * without a release date
 * (claude-sonnet-4-20250514), and with a version written in dashes
 * as the table writes it, in dots (claude-sonnet-4-5 -> claude-sonnet-4.5).
 * None of these crosses to another version of the model.
 */
function idsOf(model: string): string[] {
  const lower = model.toLowerCase();
  const bare = lower.replace(/^.*\//, '').replace(/^(?:[a-z-]+\.)+/, '');
  const undated = bare.replace(/-v\d+(?::\d+)?$/, '').replace(/-\d{8}$/, '').replace(/@\d{8}$/, '');
  const effortless = undated.replace(/-(?:minimal|low|medium|high|xhigh)$/, '');
  const dotted = effortless.replace(/-(\d)-(\d)(?=$|-)/, '-$1.$2');
  return [...new Set([model, lower, bare, undated, effortless, dotted])];
}

export const getModelPrice = (model: string, prices: PriceEntry[]): PriceEntry | null => {
  if (!prices || !model) return null;
  for (const id of idsOf(model)) {
    const exact = prices.find((p) => p.id === id);
    if (exact) return exact;
  }

  const byId = (id: string): PriceEntry | null => prices.find(p => p.id === id) ?? null;
  const lower = model.toLowerCase();

  // Custom fallback mapping for common variations
  if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3.5-sonnet')) return byId('claude-3.5-sonnet');
  if (lower.includes('claude-sonnet-4') || lower.includes('claude-4.5') || lower.includes('claude-4-5')) return byId('claude-sonnet-4.5');
  if (lower.includes('claude-3-opus')) return byId('claude-3-opus');
  if (lower.includes('gemini-3.1-pro') || lower.includes('gemini-3-1-pro')) return byId('gemini-3-1-pro-preview');
  if (lower.includes('gemini-3-pro')) return byId('gemini-3-pro-preview');
  if (lower.includes('gemini-2.5-pro')) return byId('gemini-2.5-pro');
  if (lower.includes('o1-mini')) return byId('o1-mini');
  if (lower.includes('o1-preview')) return byId('o1-preview');
  if (lower.includes('o3-mini')) return byId('o3-mini');
  if (lower.includes('gpt-4o-mini')) return byId('gpt-4o-mini');
  if (lower.includes('gpt-4o')) return byId('gpt-4o');

  // Generic fuzzy match: the longest id the model's name holds, so the answer
  // does not depend on the table's order (claude-opus-4 vs claude-opus-4-8).
  const held = prices.filter((p) => lower.includes(p.id)).sort((a, b) => b.id.length - a.id.length)[0];
  if (held) return held;
  const holding = prices.filter((p) => p.id.includes(lower)).sort((a, b) => a.id.length - b.id.length)[0];
  if (holding) return holding;

  return null;
};
