import { randomUUID } from 'crypto';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';

/**
 * Codex session JSONL: current CLI builds emit token_count events with
 * `payload.info.last_token_usage`; older builds emitted flat cumulative totals.
 * For legacy cumulative totals, per-turn deltas are recovered by subtracting
 * the previous cumulative value.
 *
 * If a delta is negative (lower than previous), treat that line's cumulative
 * as a fresh baseline (likely session reset / file rotation) — emit it as-is
 * rather than emitting a negative usage.
 */
export const parseCodexJsonl: SessionLogParser = (text, sourcePath, baseOffset) => {
  const events: TokenEvent[] = [];
  let off = baseOffset;

  let prev = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };
  let havePrev = false;
  let sessionId = '';
  let model = 'unknown';
  let turnId: string | undefined;
  let cwd: string | undefined;

  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const lineOffset = off;
    off += lineBytes + 1;

    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj?.type === 'session_meta') {
      if (typeof obj.payload?.id === 'string') sessionId = obj.payload.id;
      if (typeof obj.payload?.cwd === 'string') cwd = obj.payload.cwd;
      continue;
    }
    if (obj?.type === 'turn_context') {
      if (typeof obj.payload?.turn_id === 'string') turnId = obj.payload.turn_id;
      if (typeof obj.payload?.model === 'string') model = obj.payload.model;
      if (typeof obj.payload?.cwd === 'string') cwd = obj.payload.cwd;
      continue;
    }

    if (obj?.type !== 'event_msg') continue;
    if (obj?.payload?.type !== 'token_count') continue;

    const usage = obj.payload.info?.last_token_usage;
    const cumUsage = obj.payload.info?.total_token_usage;
    const liveUsage = usage && typeof usage === 'object' ? usage : null;
    const liveCumUsage = cumUsage && typeof cumUsage === 'object' ? cumUsage : null;
    if (obj.payload.info !== undefined && !liveUsage && !liveCumUsage) continue;

    let delta: typeof prev;
    if (liveUsage) {
      delta = tokenUsageFromCodexInfo(liveUsage);
    } else {
      const cum = liveCumUsage ? tokenUsageFromCodexInfo(liveCumUsage) : {
        input: numberOr(obj.payload.input, 0),
        cachedInput: numberOr(obj.payload.cached_input, 0),
        output: numberOr(obj.payload.output, 0),
        reasoning: numberOr(obj.payload.reasoning, 0),
        total: numberOr(obj.payload.total, 0),
      };

      delta = havePrev
        ? {
            input: cum.input - prev.input,
            cachedInput: cum.cachedInput - prev.cachedInput,
            output: cum.output - prev.output,
            reasoning: cum.reasoning - prev.reasoning,
            total: cum.total - prev.total,
          }
        : { ...cum };

      // Detect session reset: any negative component -> treat current cumulative as fresh.
      const negative =
        delta.input < 0 || delta.cachedInput < 0 || delta.output < 0 ||
        delta.reasoning < 0 || delta.total < 0;
      if (negative) delta = { ...cum };
      prev = cum;
      havePrev = true;
    }

    events.push({
      id: randomUUID(),
      ts: String(obj.timestamp ?? obj.payload.timestamp ?? new Date().toISOString()),
      client: 'codex',
      sessionId: String(obj.payload.session_id ?? obj.session_id ?? sessionId),
      turnId: typeof obj.payload.turn_id === 'string' ? obj.payload.turn_id : turnId,
      model: String(obj.payload.model ?? model),
      input: delta.input,
      cachedInput: delta.cachedInput,
      output: delta.output,
      reasoning: delta.reasoning,
      total: delta.total,
      cwd,
      sourcePath,
      sourceOffset: lineOffset,
    });
  }
  return events;
};

function numberOr(v: any, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function tokenUsageFromCodexInfo(usage: any): { input: number; cachedInput: number; output: number; reasoning: number; total: number } {
  return {
    input: numberOr(usage.input_tokens, 0),
    cachedInput: numberOr(usage.cached_input_tokens, 0),
    output: numberOr(usage.output_tokens, 0),
    reasoning: numberOr(usage.reasoning_output_tokens, 0),
    total: numberOr(usage.total_tokens, 0),
  };
}
