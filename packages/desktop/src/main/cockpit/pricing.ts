/**
 * What a Claude message cost, and how big its model's context window is
 * (INFRA-425).
 *
 * SOURCE: platform.claude.com/docs/en/about-claude/pricing.md and
 * models/overview.md, fetched 2026-10-08. USD per million tokens, first-party
 * rates (Bedrock and Google Cloud price separately; the cockpit shows the list
 * price, which is what a Claude Code session on the Claude API pays).
 *
 * A model missing from this table answers null rather than a guess: the
 * gadget then says the cost is a lower bound, which is true, where a borrowed
 * price would be a confident wrong number.
 */

interface Rates {
  readonly input: number;
  readonly write5m: number;
  readonly write1h: number;
  readonly read: number;
  readonly output: number;
}

const r = (input: number, write5m: number, write1h: number, read: number, output: number): Rates =>
  ({ input, write5m, write1h, read, output });

/** Keyed by the id without any date or bracket suffix. */
const PRICES: Readonly<Record<string, Rates>> = {
  'claude-fable-5-1': r(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': r(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': r(10, 12.5, 20, 1, 50),
  'claude-mythos-5': r(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': r(4, 5, 8, 0.2, 20),
  'claude-opus-5': r(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-8': r(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-7': r(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': r(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': r(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': r(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': r(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': r(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': r(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': r(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': r(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': r(3, 3.75, 6, 0.3, 15),
  'claude-haiku-4-5': r(1, 1.25, 2, 0.1, 5),
  'claude-3-5-haiku': r(0.8, 1, 1.6, 0.08, 4),
};

/** Claude Haiku 5.5 is priced by prompt length: above 100,000 tokens, the second row. */
const HAIKU_5_5_SHORT = r(0.1, 0.125, 0.2, 0.01, 0.5);
const HAIKU_5_5_LONG = r(0.5, 0.625, 1, 0.05, 2.5);
const HAIKU_5_5_THRESHOLD = 100_000;

/** 1M from the 4.6 generation on (and Haiku 5.5); 200K for the 4.5 models and earlier. */
const WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-3-5-haiku': 200_000,
};
const MILLION_WINDOW = new Set([
  'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-5-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-haiku-5-5',
]);

/** `claude-haiku-4-5-20251001` and `claude-opus-5-5[1m]` are the same model as their base id. */
export const baseModelId = (model: string): string =>
  model.trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /** 'fast' for fast mode, billed at a premium. */
  speed?: string;
  /** 'us' for US-only inference, billed at 1.1x on Claude 4.6 and later. */
  inference_geo?: string;
  server_tool_use?: { web_search_requests?: number };
}

/*
 * Fast mode, as a multiple of the standard rates (the page lists Opus 5.5 at
 * $8/$40 against $4/$20, Opus 5 and 4.8 at $10/$50 against $5/$25); caching
 * multipliers apply on top. A model not listed has no fast mode, and a fast
 * message on one answers null.
 */
const FAST_MULTIPLIER: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 2, 'claude-opus-5': 2, 'claude-opus-4-8': 2,
};

/** US-only inference costs 1.1x on these: Claude 4.6 and later. */
const GEO_PRICED = new Set([
  'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-5-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-haiku-5-5',
]);

/** $10 per 1,000 web searches, on top of tokens. */
const WEB_SEARCH_USD = 0.01;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** USD for one assistant message, or null for a model this table does not price. */
export function claudeMessageCost(model: string, usage: ClaudeUsage): number | null {
  const id = baseModelId(model);
  const input = n(usage.input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const split = usage.cache_creation;
  const w1h = n(split?.ephemeral_1h_input_tokens);
  // An unsplit total is the 5-minute kind: the default TTL, and what older
  // transcripts recorded before the split existed.
  const w5m = split ? n(split.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens);
  const output = n(usage.output_tokens);
  let rates: Rates | undefined = PRICES[id];
  if (id === 'claude-haiku-5-5') {
    rates = input + read + w5m + w1h > HAIKU_5_5_THRESHOLD ? HAIKU_5_5_LONG : HAIKU_5_5_SHORT;
  }
  if (!rates) return null;
  let factor = 1;
  if (usage.speed === 'fast') {
    const fast = FAST_MULTIPLIER[id];
    if (!fast) return null;
    factor *= fast;
  }
  if (usage.inference_geo === 'us' && GEO_PRICED.has(id)) factor *= 1.1;
  const tokens = (input * rates.input + w5m * rates.write5m + w1h * rates.write1h + read * rates.read + output * rates.output) / 1e6;
  return tokens * factor + n(usage.server_tool_use?.web_search_requests) * WEB_SEARCH_USD;
}

/** Tokens the model can hold, or null when this table does not know the model. */
export function claudeContextWindow(model: string): number | null {
  const id = baseModelId(model);
  if (MILLION_WINDOW.has(id)) return 1_000_000;
  return WINDOWS[id] ?? null;
}
