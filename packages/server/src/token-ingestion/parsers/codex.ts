import { randomUUID } from 'crypto';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';

/**
 * Codex session JSONL: each line is an event_msg, and `payload.type === 'token_count'`
 * lines carry CUMULATIVE totals for the session. Per-turn deltas are recovered
 * by subtracting the previous cumulative within the same slice.
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

  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const lineOffset = off;
    off += lineBytes + 1;

    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj?.type !== 'event_msg') continue;
    if (obj?.payload?.type !== 'token_count') continue;

    const cum = {
      input: numberOr(obj.payload.input, 0),
      cachedInput: numberOr(obj.payload.cached_input, 0),
      output: numberOr(obj.payload.output, 0),
      reasoning: numberOr(obj.payload.reasoning, 0),
      total: numberOr(obj.payload.total, 0),
    };

    let delta = havePrev
      ? {
          input: cum.input - prev.input,
          cachedInput: cum.cachedInput - prev.cachedInput,
          output: cum.output - prev.output,
          reasoning: cum.reasoning - prev.reasoning,
          total: cum.total - prev.total,
        }
      : { ...cum };

    // Detect session reset: any negative component → treat current cumulative as fresh.
    const negative =
      delta.input < 0 || delta.cachedInput < 0 || delta.output < 0 ||
      delta.reasoning < 0 || delta.total < 0;
    if (negative) delta = { ...cum };

    events.push({
      id: randomUUID(),
      ts: String(obj.timestamp ?? obj.payload.timestamp ?? new Date().toISOString()),
      client: 'codex',
      sessionId: String(obj.payload.session_id ?? obj.session_id ?? ''),
      turnId: typeof obj.payload.turn_id === 'string' ? obj.payload.turn_id : undefined,
      model: String(obj.payload.model ?? 'unknown'),
      input: delta.input,
      cachedInput: delta.cachedInput,
      output: delta.output,
      reasoning: delta.reasoning,
      total: delta.total,
      sourcePath,
      sourceOffset: lineOffset,
    });

    prev = cum;
    havePrev = true;
  }
  return events;
};

function numberOr(v: any, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
