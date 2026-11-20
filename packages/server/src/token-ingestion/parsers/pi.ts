import { randomUUID } from 'crypto';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';
import { numberOr } from './numbers';

/** The header fields later records depend on, kept across passes. */
interface PiState {
  sessionId: string;
  cwd?: string;
}

/**
 * Parses a slice of a pi session JSONL file (~/.pi/agent/sessions/<cwd-slug>/
 * <ts>_<uuid>.jsonl), GH-389.
 *
 * The first record is the session header: `{ type: 'session', id, cwd }`. Usage
 * is on `message` records whose `message.role` is 'assistant', one per model
 * response: `{ input, output, cacheRead, cacheWrite, reasoning, totalTokens,
 * cost: { total } }`. `input` is fresh input only (cache reads are separate),
 * so it maps straight across. Streaming `message_update` records and tool
 * results are not turns and are ignored.
 *
 * A forked session copies earlier records into a new file under a new header,
 * so the response id, not the record id, identifies the turn across files; a
 * response with no id falls back to session id + record id.
 *
 * The header is only at the top of the file, so it is saved in `ctx.state`
 * for passes that start further down.
 */
export const parsePiJsonl: SessionLogParser = (text, sourcePath, baseOffset, ctx) => {
  const events: TokenEvent[] = [];
  const saved = (ctx?.state ?? null) as PiState | null;
  let sessionId = saved?.sessionId ?? '';
  let cwd = saved?.cwd;
  let off = baseOffset;

  for (const line of text.split('\n')) {
    const lineOffset = off;
    off += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj?.type === 'session') {
      if (typeof obj.id === 'string') sessionId = obj.id;
      if (typeof obj.cwd === 'string') cwd = obj.cwd;
      continue;
    }
    if (obj?.type !== 'message') continue;
    const msg = obj.message;
    if (msg?.role !== 'assistant') continue;
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = numberOr(usage.input, 0);
    const output = numberOr(usage.output, 0);
    const cacheRead = numberOr(usage.cacheRead, 0);
    const cacheWrite = numberOr(usage.cacheWrite, 0);
    const reasoning = numberOr(usage.reasoning, 0);
    const total = numberOr(usage.totalTokens, input + output + cacheRead + cacheWrite);
    if (input + output + cacheRead + cacheWrite + total === 0) continue;

    const responseId = typeof msg.responseId === 'string' && msg.responseId ? msg.responseId : undefined;
    const recordId = typeof obj.id === 'string' ? obj.id : undefined;
    const dedupKey = responseId ?? (recordId ? `${sessionId}:${recordId}` : undefined);
    const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost.total : undefined;

    events.push({
      id: randomUUID(),
      ts: String(obj.timestamp ?? new Date().toISOString()),
      client: 'pi',
      sessionId,
      turnId: recordId,
      model: String(msg.model ?? 'unknown'),
      input,
      cachedInput: cacheRead + cacheWrite,
      cacheRead,
      cacheWrite,
      output,
      reasoning,
      total,
      ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
      ...(dedupKey ? { dedupKey } : {}),
      cwd,
      sourcePath,
      sourceOffset: lineOffset,
    });
  }

  if (ctx) ctx.state = { sessionId, cwd } satisfies PiState;
  return events;
};

