import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { TokenEvent } from '@agenfk/core';
import type { SessionLogParser } from '../watcher';
import type { TranscriptClaim } from './claude-code';
import { numberOr } from './numbers';

// Built-in Node 22+ sqlite module (same pattern as @agenfk/storage-sqlite).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

interface PendingCall {
  kind: 'gatekeeper' | 'verify';
  itemRef: string | null;
  at: string;
  sessionId: string;
}

interface AgyState {
  cwd?: string;
  pending?: Record<string, PendingCall[]>;
}

const MAX_PENDING = 200;
const ID_REF = /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const AGENFK_CALL = /(?:^|[\s(])agenfk\s+(gatekeeper|verify)\b(.*)$/s;

const unquoteId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  return trimmed && ID_REF.test(trimmed) ? trimmed : null;
};

/**
 * Antigravity transcript tool_calls serialize each arg value as a JSON string
 * (e.g. `ServerName: "\"agenfk\""`, `Arguments: "{\"itemId\":\"...\"}"`).
 * Decode JSON-encoded values cleanly while also accepting raw values.
 */
function parseArg(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Extract conversation id from `<root>/brain/<convId>/.system_generated/logs/transcript.jsonl`. */
function conversationIdFromPath(sourcePath: string): string {
  const norm = sourcePath.replace(/\\/g, '/');
  const m = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/.exec(norm);
  if (m) return m[1];
  return path.basename(path.dirname(sourcePath));
}

/**
 * Resolve workspace `cwd` for an Antigravity conversation from
 * `<agyDir>/conversation_summaries.db` (read-only). Returns undefined when the
 * DB is absent, unreadable, or has no `file://` workspace URI for this id.
 */
export function resolveAgyCwd(sourcePath: string, conversationId: string): string | undefined {
  if (!conversationId) return undefined;
  // <agyDir>/brain/<convId>/.system_generated/logs/transcript.jsonl -> <agyDir>
  const agyDir = path.resolve(path.dirname(sourcePath), '..', '..', '..', '..');
  const dbPath = path.join(agyDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return undefined;

  let db: InstanceType<typeof sqlite.DatabaseSync> | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?')
      .get(conversationId) as { workspace_uris?: unknown } | undefined;
    if (!row || typeof row.workspace_uris !== 'string' || !row.workspace_uris.trim()) return undefined;
    const uris = JSON.parse(row.workspace_uris);
    if (!Array.isArray(uris)) return undefined;
    for (const uri of uris) {
      if (typeof uri !== 'string') continue;
      if (uri.startsWith('file://')) {
        try {
          return fileURLToPath(uri);
        } catch {
          continue;
        }
      }
      if (path.isAbsolute(uri)) return uri;
    }
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore close errors */ }
  }
  return undefined;
}

/** Extract AgEnFK gatekeeper/verify calls from shell `run_command` strings. */
function shellCalls(command: string): Array<Pick<PendingCall, 'kind' | 'itemRef'>> {
  const calls: Array<Pick<PendingCall, 'kind' | 'itemRef'>> = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const m = AGENFK_CALL.exec(segment);
    if (!m) continue;
    const args = m[2];
    if (m[1] === 'verify') {
      if (/(?:^|\s)--plan\b/.test(args)) continue;
      const ref = unquoteId(args.trim().split(/\s+/)[0]);
      if (ref) calls.push({ kind: 'verify', itemRef: ref });
    } else {
      const flag = /--item-id(?:=|\s+)(\S+)/.exec(args);
      calls.push({ kind: 'gatekeeper', itemRef: flag ? unquoteId(flag[1]) : null });
    }
  }
  return calls;
}

/**
 * The card a gatekeeper reply authorizes, '' when it authorizes without naming
 * one, or null when the reply refuses (or the step errored).
 */
function gatekeeperOutcome(reply: string, isError: boolean): string | null | '' {
  const authorized = /✅ AUTHORIZED|"authorized"\s*:\s*true/.test(reply);
  if (authorized) {
    const named = /"task"\s*:\s*\{\s*"id"\s*:\s*"([0-9a-f-]{8,36})"/.exec(reply) ?? /\n[A-Z]+: \[([0-9a-f-]{8,36})\]/.exec(reply);
    return named ? named[1] : '';
  }
  if (isError || reply.includes('❌') || /"authorized"\s*:\s*false/.test(reply)) return null;
  return null;
}

/**
 * Record AgEnFK tool calls from a PLANNER_RESPONSE as pending, keyed by the
 * expected result step_index (`step_index + 1 + toolCallIndex`).
 */
function noteCalls(
  stepIndex: number | undefined,
  toolCalls: unknown,
  sessionId: string,
  at: string,
  pending: Record<string, PendingCall[]>,
): void {
  if (stepIndex === undefined || !Array.isArray(toolCalls) || !sessionId || !at) return;
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!tc || typeof tc !== 'object') continue;
    const name = typeof tc.name === 'string' ? tc.name : '';
    const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
    const calls: Array<Pick<PendingCall, 'kind' | 'itemRef'>> = [];

    if (name === 'call_mcp_tool') {
      const server = parseArg(args.ServerName);
      const tool = parseArg(args.ToolName);
      if (server === 'agenfk') {
        const toolArgs = parseArg(args.Arguments);
        if (toolArgs && typeof toolArgs === 'object') {
          if (tool === 'validate_progress' && !(toolArgs as any).plan) {
            const ref = unquoteId((toolArgs as any).itemId);
            if (ref) calls.push({ kind: 'verify', itemRef: ref });
          } else if (tool === 'workflow_gatekeeper') {
            calls.push({ kind: 'gatekeeper', itemRef: unquoteId((toolArgs as any).itemId) });
          }
        }
      }
    } else if (name === 'mcp_agenfk_validate_progress') {
      if (!parseArg(args.plan)) {
        const ref = unquoteId(parseArg(args.itemId));
        if (ref) calls.push({ kind: 'verify', itemRef: ref });
      }
    } else if (name === 'mcp_agenfk_workflow_gatekeeper') {
      calls.push({ kind: 'gatekeeper', itemRef: unquoteId(parseArg(args.itemId)) });
    } else if (name === 'run_command') {
      const cmd = parseArg(args.CommandLine);
      if (typeof cmd === 'string') calls.push(...shellCalls(cmd));
    }

    if (calls.length) {
      const resultKey = String(stepIndex + 1 + i);
      pending[resultKey] = calls.map((c) => ({ ...c, at, sessionId }));
    }
  }

  const keys = Object.keys(pending);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PENDING))) delete pending[key];
}

/** Settle pending calls when their corresponding tool-result step arrives. */
function settleCalls(
  obj: any,
  pending: Record<string, PendingCall[]>,
  claims: TranscriptClaim[],
): void {
  const stepIndex = typeof obj?.step_index === 'number' && Number.isFinite(obj.step_index)
    ? String(obj.step_index)
    : null;
  if (!stepIndex || !(stepIndex in pending)) return;

  const calls = pending[stepIndex];
  delete pending[stepIndex];
  const reply = typeof obj.content === 'string' ? obj.content : '';
  const isError = obj.status === 'ERROR';

  for (const call of calls) {
    let itemRef = call.itemRef;
    if (call.kind === 'gatekeeper') {
      const outcome = gatekeeperOutcome(reply, isError);
      if (outcome === null) continue;
      itemRef = itemRef ?? (outcome || null);
    }
    if (itemRef) claims.push({ sessionId: call.sessionId, agentId: '', itemRef, at: call.at });
  }
}

/**
 * Parses a slice of an Antigravity (`agy`) transcript JSONL file:
 *   ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
 *   ~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl
 *
 * Each `PLANNER_RESPONSE` line with token counts yields one `TokenEvent`.
 * Workspace `cwd` is resolved from `conversation_summaries.db` and cached in
 * `ctx.state` once resolved (unresolved lookups retry on later passes).
 * AgEnFK MCP / CLI tool calls are held until their result step confirms them
 * and emitted as `TranscriptClaim`s so turns attribute to the active card.
 */
export const parseAgyJsonl: SessionLogParser = (text, sourcePath, baseOffset, ctx) => {
  const events: TokenEvent[] = [];
  const sessionId = conversationIdFromPath(sourcePath);
  const saved = (ctx?.state ?? null) as AgyState | null;
  const cwd = saved?.cwd || resolveAgyCwd(sourcePath, sessionId);
  const pending: Record<string, PendingCall[]> = { ...(saved?.pending ?? {}) };

  let off = baseOffset;
  for (const line of text.split('\n')) {
    const lineOffset = off;
    off += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj?.type !== 'PLANNER_RESPONSE') {
      if (ctx?.claims) settleCalls(obj, pending, ctx.claims);
      continue;
    }

    const stepIndex = typeof obj.step_index === 'number' && Number.isFinite(obj.step_index)
      ? obj.step_index
      : undefined;
    const at = typeof obj.created_at === 'string' && obj.created_at ? obj.created_at : new Date().toISOString();
    if (ctx?.claims) noteCalls(stepIndex, obj.tool_calls, sessionId, at, pending);

    const input = numberOr(obj.input_tokens, 0);
    const cacheRead = numberOr(obj.cache_read_tokens, 0);
    const cacheWrite = numberOr(obj.cache_write_tokens, 0);
    const output = numberOr(obj.output_tokens, 0);
    const reasoning = numberOr(obj.thinking_tokens ?? obj.reasoning_tokens, 0);
    const cachedInput = cacheRead + cacheWrite;
    const total = input + cachedInput + output;
    if (total === 0) continue;

    const turnId = stepIndex !== undefined ? String(stepIndex) : undefined;
    const dedupKey = sessionId && turnId ? `${sessionId}:${turnId}` : undefined;

    events.push({
      id: randomUUID(),
      ts: at,
      client: 'agy',
      sessionId,
      turnId,
      model: typeof obj.model === 'string' && obj.model ? obj.model : 'unknown',
      input,
      cachedInput,
      cacheRead,
      cacheWrite,
      output,
      reasoning,
      total,
      ...(dedupKey ? { dedupKey } : {}),
      cwd,
      sourcePath,
      sourceOffset: lineOffset,
    });
  }

  if (ctx) {
    const nextState: AgyState = {};
    if (cwd) nextState.cwd = cwd;
    if (Object.keys(pending).length) nextState.pending = pending;
    ctx.state = nextState;
  }
  return events;
};
