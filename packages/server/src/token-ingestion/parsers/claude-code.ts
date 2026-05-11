import { randomUUID } from 'crypto';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';

/**
 * Parses a slice of a Claude Code session JSONL file. Each line is a JSON
 * object; lines with `type === 'assistant'` and a `message.usage` block
 * yield one TokenEvent per line.
 *
 * Cached input combines `cache_creation_input_tokens` + `cache_read_input_tokens`
 * because both represent input that was non-fresh at the model's turn.
 *
 * `client` is left as 'claude-code' but the runtime watcher will overwrite it
 * with the configured source name.
 */
export const parseClaudeCodeJsonl: SessionLogParser = (text, sourcePath, baseOffset) => {
  const events: TokenEvent[] = [];
  let off = baseOffset;

  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const lineOffset = off;
    off += lineBytes + 1; // +1 for the \n delimiter we split on

    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj?.type !== 'assistant') continue;
    const usage = obj?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = numberOr(usage.input_tokens, 0);
    const cachedInput =
      numberOr(usage.cache_creation_input_tokens, 0) + numberOr(usage.cache_read_input_tokens, 0);
    const output = numberOr(usage.output_tokens, 0);
    const reasoning = 0; // not separated in Claude's wire format
    const total = input + cachedInput + output;

    events.push({
      id: randomUUID(),
      ts: String(obj.timestamp ?? new Date().toISOString()),
      client: 'claude-code',
      sessionId: String(obj.sessionId ?? ''),
      turnId: typeof obj.uuid === 'string' ? obj.uuid : undefined,
      model: String(obj.message?.model ?? 'unknown'),
      input,
      cachedInput,
      output,
      reasoning,
      total,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      sourcePath,
      sourceOffset: lineOffset,
    });
  }
  return events;
};

function numberOr(v: any, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
