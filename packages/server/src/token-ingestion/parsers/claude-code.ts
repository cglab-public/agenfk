import { randomUUID } from 'crypto';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';

/**
 * Parses a slice of a Claude Code session JSONL file. Each line is a JSON
 * object; lines with `type === 'assistant'` and a `message.usage` block yield
 * one TokenEvent per MESSAGE (GH-389).
 *
 * Claude Code writes one line per content block (thinking, text, tool_use) and
 * every one of them repeats the same `message.usage`, so counting lines
 * overcounted a real session ~1.85x. The first line of a message carries the
 * event, at that line's offset, keyed on `message.id`; the storage rejects the
 * same key again, which also covers a message repeated in a later pass or in
 * the session's subagent log. A line with no message id is counted on its own.
 *
 * Cached input combines `cache_creation_input_tokens` + `cache_read_input_tokens`
 * because both represent input that was non-fresh at the model's turn.
 *
 * `client` is left as 'claude-code' but the runtime watcher will overwrite it
 * with the configured source name.
 */
export const parseClaudeCodeJsonl: SessionLogParser = (text, sourcePath, baseOffset) => {
  const events: TokenEvent[] = [];
  const seenMessages = new Set<string>();
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

    const messageId = typeof obj.message?.id === 'string' && obj.message.id ? obj.message.id : undefined;
    if (messageId) {
      if (seenMessages.has(messageId)) continue;
      seenMessages.add(messageId);
    }

    const input = numberOr(usage.input_tokens, 0);
    const cacheWrite = numberOr(usage.cache_creation_input_tokens, 0);
    const cacheRead = numberOr(usage.cache_read_input_tokens, 0);
    const cachedInput = cacheWrite + cacheRead;
    const output = numberOr(usage.output_tokens, 0);
    const reasoning = 0; // not separated in Claude's wire format
    const total = input + cachedInput + output;

    events.push({
      id: randomUUID(),
      ts: String(obj.timestamp ?? new Date().toISOString()),
      client: 'claude-code',
      sessionId: String(obj.sessionId ?? ''),
      turnId: messageId ?? (typeof obj.uuid === 'string' ? obj.uuid : undefined),
      ...(messageId ? { dedupKey: messageId } : {}),
      model: String(obj.message?.model ?? 'unknown'),
      input,
      cachedInput,
      cacheRead,
      cacheWrite,
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
