import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';
import { numberOr } from './numbers';

/**
 * GH-398: a transcript named a card through its own agenfk call. `itemRef` is
 * the id as written (a short id is resolved against the store later); `at` is
 * the call's time, when the server saw it - a closing verify's close lands
 * before its reply is written. `agentId` is '' for the session's own transcript.
 */
export interface TranscriptClaim {
  sessionId: string;
  agentId: string;
  itemRef: string;
  at: string;
}

/** A call waiting for its reply: a gatekeeper claims only if it was not refused. */
interface PendingCall {
  kind: 'gatekeeper' | 'verify';
  itemRef: string | null;
  at: string;
  sessionId: string;
  agentId: string;
}

interface ClaimState {
  pending: Record<string, PendingCall>;
}

/** Calls whose reply never came (an interrupted tool) are dropped beyond this many. */
const MAX_PENDING = 200;

const ID_REF = /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const AGENFK_CALL = /(?:^|[\s(])agenfk\s+(gatekeeper|verify)\b(.*)$/s;

const unquote = (token: string | undefined): string | null => {
  const t = token?.replace(/^["']|["']$/g, '');
  return t && ID_REF.test(t) ? t : null;
};

/** The agenfk gatekeeper and verify calls in a shell command, in order. */
function shellCalls(command: string): Array<Pick<PendingCall, 'kind' | 'itemRef'>> {
  const calls: Array<Pick<PendingCall, 'kind' | 'itemRef'>> = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const m = AGENFK_CALL.exec(segment);
    if (!m) continue;
    const args = m[2];
    if (m[1] === 'verify') {
      if (/(?:^|\s)--plan\b/.test(args)) continue;
      const itemRef = unquote(args.trim().split(/\s+/)[0]);
      if (itemRef) calls.push({ kind: 'verify', itemRef });
    } else {
      const flag = /--item-id(?:=|\s+)(\S+)/.exec(args);
      calls.push({ kind: 'gatekeeper', itemRef: flag ? unquote(flag[1]) : null });
    }
  }
  return calls;
}

function replyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * The card a gatekeeper reply authorizes, '' when it authorizes without naming
 * one, or null when the reply refuses (or the call failed with nothing to show).
 */
function gatekeeperOutcome(reply: string, isError: boolean): string | null | '' {
  const authorized = /✅ AUTHORIZED|"authorized"\s*:\s*true/.test(reply);
  if (authorized) {
    const named = /"task"\s*:\s*\{\s*"id"\s*:\s*"([0-9a-f-]{8,36})"/.exec(reply) ?? /\n[A-Z]+: \[([0-9a-f]{8,36})\]/.exec(reply);
    return named ? named[1] : '';
  }
  if (isError || reply.includes('❌') || /"authorized"\s*:\s*false/.test(reply)) return null;
  return '';
}

/** Records the agenfk calls of an assistant record as pending, until their replies. */
function noteCalls(obj: any, state: ClaimState): void {
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return;
  const at = String(obj.timestamp ?? '');
  const sessionId = String(obj.sessionId ?? '');
  const agentId = typeof obj.agentId === 'string' ? obj.agentId : '';
  for (const block of content) {
    if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
    const calls: Array<Pick<PendingCall, 'kind' | 'itemRef'>> = [];
    if (block.name === 'Bash' && typeof block.input?.command === 'string') calls.push(...shellCalls(block.input.command));
    else if (block.name === 'mcp__agenfk__workflow_gatekeeper') calls.push({ kind: 'gatekeeper', itemRef: unquote(block.input?.itemId) });
    else if (block.name === 'mcp__agenfk__validate_progress' && !block.input?.plan) {
      const itemRef = unquote(block.input?.itemId);
      if (itemRef) calls.push({ kind: 'verify', itemRef });
    }
    calls.forEach((call, i) => { state.pending[`${block.id}#${i}`] = { ...call, at, sessionId, agentId }; });
  }
  const keys = Object.keys(state.pending);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PENDING))) delete state.pending[key];
}

/** Turns the replies in a user record into claims. */
function settleCalls(obj: any, state: ClaimState, claims: TranscriptClaim[]): void {
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    for (let i = 0; `${block.tool_use_id}#${i}` in state.pending; i++) {
      const key = `${block.tool_use_id}#${i}`;
      const call = state.pending[key];
      delete state.pending[key];
      let itemRef = call.itemRef;
      if (call.kind === 'gatekeeper') {
        const outcome = gatekeeperOutcome(replyText(block.content), block.is_error === true);
        if (outcome === null) continue;
        itemRef = itemRef ?? (outcome || null);
      }
      if (itemRef) claims.push({ sessionId: call.sessionId, agentId: call.agentId, itemRef, at: call.at });
    }
  }
}

/** GH-398: a Claude Code session log whose session has run subagents (`<session>/subagents/` beside it). */
export async function hasSubagents(sessionLog: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(path.join(sessionLog.replace(/\.jsonl$/, ''), 'subagents'))).isDirectory();
  } catch {
    return false;
  }
}

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
export const parseClaudeCodeJsonl: SessionLogParser = (text, sourcePath, baseOffset, ctx) => {
  const events: TokenEvent[] = [];
  const seenMessages = new Set<string>();
  const prior = ctx?.state as Partial<ClaimState> | null | undefined;
  const claimState: ClaimState = { pending: { ...(prior?.pending ?? {}) } };
  let off = baseOffset;

  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const lineOffset = off;
    off += lineBytes + 1; // +1 for the \n delimiter we split on

    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (ctx && obj?.type === 'user') settleCalls(obj, claimState, ctx.claims ??= []);
    if (obj?.type !== 'assistant') continue;
    if (ctx) noteCalls(obj, claimState);
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
      ...(typeof obj.agentId === 'string' && obj.agentId ? { agentId: obj.agentId } : {}),
    });
  }
  if (ctx) ctx.state = Object.keys(claimState.pending).length ? claimState : null;
  return events;
};

