/**
 * An agent's context and cost, read from its own transcript as it grows
 * (INFRA-425).
 *
 * Fed in CHUNKS: the caller reads only what was appended since the last time
 * (the files run to megabytes), so a line can arrive in two halves and is held
 * until its newline does.
 *
 * Claude Code writes one line per content block of an assistant message, each
 * repeating the message's usage, so usage is counted once per message id.
 * pi writes one line per message with the cost already computed.
 */
import { claudeContextWindow, claudeMessageCost, type ClaudeUsage } from './pricing.js';

export type TranscriptKind = 'claude' | 'pi';

export interface UsageSnapshot {
  readonly model: string | null;
  readonly provider: string | null;
  /** Tokens in the context at the last message, or null before any. */
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  /** USD so far in this session. */
  readonly cost: number;
  /** False when a message's cost could not be known: `cost` is a lower bound. */
  readonly costComplete: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class UsageAccumulator {
  private pending = '';
  private model: string | null = null;
  private provider: string | null = null;
  private contextTokens: number | null = null;
  private cost = 0;
  private costComplete = true;
  private readonly seen = new Set<string>();

  constructor(private readonly kind: TranscriptKind) {}

  feed(chunk: string): void {
    const text = this.pending + chunk;
    const lines = text.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  snapshot(): UsageSnapshot {
    return {
      model: this.model,
      provider: this.provider,
      contextTokens: this.contextTokens,
      contextWindow: this.kind === 'claude' && this.model ? claudeContextWindow(this.model) : null,
      cost: this.cost,
      costComplete: this.costComplete,
    };
  }

  private line(raw: string): void {
    // Cheap filter first: most lines are tool output with no usage at all.
    if (!raw.includes('"usage"')) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.kind === 'claude') this.claude(entry);
    else this.pi(entry);
  }

  private claude(entry: Record<string, unknown>): void {
    if (entry.type !== 'assistant') return;
    const message = entry.message as { id?: unknown; model?: unknown; usage?: ClaudeUsage } | undefined;
    if (!message?.usage || typeof message.model !== 'string') return;
    const id = typeof message.id === 'string' ? message.id : null;
    if (id && this.seen.has(id)) return;
    if (id) this.seen.add(id);
    // Written by Claude Code itself (an interrupted turn, a local notice):
    // no API call, nothing billed, and not the model the session runs on.
    if (message.model === '<synthetic>') return;
    const u = message.usage;
    this.model = message.model;
    this.contextTokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    const cost = claudeMessageCost(message.model, u);
    if (cost === null) this.costComplete = false;
    else this.cost += cost;
  }

  private pi(entry: Record<string, unknown>): void {
    if (entry.type !== 'message') return;
    const message = entry.message as {
      role?: unknown; model?: unknown; provider?: unknown;
      usage?: { totalTokens?: unknown; cost?: { total?: unknown } };
    } | undefined;
    if (!message?.usage || message.role !== 'assistant') return;
    if (typeof message.model === 'string') this.model = message.model;
    if (typeof message.provider === 'string') this.provider = message.provider;
    // pi's totalTokens is the whole context at that message, not a delta.
    this.contextTokens = num(message.usage.totalTokens);
    const cost = message.usage.cost?.total;
    if (typeof cost === 'number' && Number.isFinite(cost)) this.cost += cost;
    else this.costComplete = false;
  }
}

/**
 * The context window pi was told for a model, from its models.json. pi's own
 * configuration is the only place a self-hosted model's window is written down.
 */
export function piContextWindow(modelsJson: string, provider: string, model: string): number | null {
  try {
    const parsed = JSON.parse(modelsJson) as { providers?: Record<string, { models?: Array<{ id?: unknown; contextWindow?: unknown }> }> };
    const found = parsed.providers?.[provider]?.models?.find(m => m.id === model);
    return typeof found?.contextWindow === 'number' ? found.contextWindow : null;
  } catch {
    return null;
  }
}
