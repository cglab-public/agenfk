/**
 * GH-389: what AI usage cost, shared by the board (packages/ui) and the hub's
 * /usage page (packages/hub-ui) so both price a model the same way.
 *
 * Harnesses that price their own turns (pi) report it; for the rest the cost
 * can only be ESTIMATED from a public price table, and is labelled so.
 */

/** Where the price table comes from (USD per million tokens). */
export const PRICES_URL = 'https://www.llm-prices.com/current-v1.json';

/** One model's usage, as far as pricing needs it. */
export interface PricedModelUsage {
  model: string;
  turns: number;
  unpricedTurns: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostView {
  /** What the harnesses reported, in USD. */
  reported: number;
  /** The board's estimate for models none of whose turns were priced. */
  estimated: number;
  /** Models with unpriced turns the board could not estimate. */
  unpricedModels: string[];
  /** Models whose cost is the board's estimate. */
  estimatedModels: string[];
}

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

/**
 * Cost per model: what was reported, plus an estimate from the board's price
 * table (USD per million tokens) for a model NONE of whose turns were priced.
 * Cache reads at the table's cached-input rate (else the input rate), cache
 * writes at the input rate - an estimate, labelled as one wherever it shows.
 */
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
  // price a model at $0 silently); the cached rate is optional (falls back to input).
  // A blank id would match every model in the fuzzy lookup.
  const prices = rows.filter((r): r is PriceEntry => {
    if (!r || typeof r !== 'object') return false;
    const e = r as PriceEntry;
    return typeof e.id === 'string' && e.id.trim() !== '' && rate(e.input) && rate(e.output)
      && (e.input_cached === undefined || rate(e.input_cached));
  });
  return { prices };
}

export function estimateCost(byModel: PricedModelUsage[], pricesData: PricesData | null | undefined): CostView {
  const view: CostView = { reported: 0, estimated: 0, unpricedModels: [], estimatedModels: [] };
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
    view.estimatedModels.push(m.model);
    view.estimated += (m.input * input + m.output * (Number(price.output) || 0) + m.cacheRead * cached + m.cacheWrite * input) / 1_000_000;
  }
  return view;
}

export const getModelPrice = (model: string, prices: PriceEntry[]): PriceEntry | null => {
  if (!prices || !model) return null;
  const exact = prices.find((p) => p.id === model);
  if (exact) return exact;
  
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

  // Generic fuzzy match
  const fuzzy = prices.find((p) => lower.includes(p.id) || p.id.includes(lower));
  if (fuzzy) return fuzzy;
  
  return null;
};
