/**
 * CGLAB-381 — who reviewed, read from the reviewer's own transcript.
 *
 * An independent review is only worth recording if the server can tell the
 * reviewer apart from the author. A request can claim any identity, so the
 * identity comes from the TRANSCRIPT the harness wrote for the reviewer:
 * - Claude Code: a sub-agent's transcript (`isSidechain`) carries the parent
 *   session and its own `agentId`; a separate session carries its own id.
 * - pi: the session header `{ type: 'session', id }`.
 * - Codex: the `session_meta` record's `payload.id`.
 *
 * Only files under those harnesses' session folders are read - through
 * symlinks too - so a review record is never a way to read an arbitrary file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Identity {
  client: string;
  sessionId: string;
  /** A sub-agent inside the session; null for the session's own thread. */
  agentId: string | null;
}

export interface TranscriptIdentity extends Identity {
  transcript: string;
  /** The latest timestamp in the transcript's records. */
  lastAt: string | null;
  /** When the file itself was last written. */
  mtime: string;
  /** Files the reviewer's tool calls edited: a reviewer that edits the card's tree is an author. */
  edits: string[];
  /** Whether the reviewer ran `agenfk verify` (or a status move): advancing cards is an author's act. */
  advancedCards: boolean;
}

export interface Finding {
  title: string;
  state: 'fixed' | 'rejected';
  reason?: string;
}

const ROOTS: Array<{ client: string; rel: string }> = [
  { client: 'claude-code', rel: '.claude/projects' },
  { client: 'pi', rel: '.pi/agent/sessions' },
  { client: 'codex', rel: '.codex/sessions' },
];

const realOr = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };

/** Which harness folder a transcript lives in, judged on its REAL path; null when none. */
export function transcriptRoot(file: string): { client: string; root: string; rel: string } | null {
  const real = realOr(path.resolve(file));
  if (!real) return null;
  for (const r of ROOTS) {
    const root = realOr(path.join(os.homedir(), r.rel));
    if (!root) continue;
    const rel = path.relative(root, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { client: r.client, root, rel };
  }
  return null;
}

/**
 * Does the file sit where its harness writes a transcript for the identity it
 * names? Claude Code: `<project>/<session>.jsonl`, or a sub-agent's
 * `<project>/<session>/subagents/agent-<id>.jsonl` beside an existing parent
 * `<project>/<session>.jsonl`. pi and Codex name the session in the file name.
 * A cheap bar, not a proof: any agent running as the user can write a file
 * that passes it (noted on CGLAB-383).
 */
function layoutError(where: { client: string; root: string; rel: string }, sessionId: string, agentId: string | null): string | null {
  const parts = where.rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (where.client === 'claude-code') {
    if (agentId) {
      const ok = parts.length === 4 && parts[1] === sessionId && parts[2] === 'subagents' && base === `agent-${agentId}.jsonl`;
      if (!ok) return `the sub-agent transcript's layout does not match its session ${sessionId} and agent ${agentId} (<project>/<session>/subagents/agent-<id>.jsonl)`;
      if (!fs.existsSync(path.join(where.root, parts[0], `${sessionId}.jsonl`))) return `no parent session transcript ${sessionId}.jsonl sits beside the sub-agent's folder`;
      return null;
    }
    return parts.length === 2 && base === `${sessionId}.jsonl` ? null : `the transcript's name does not match its session ${sessionId} (<project>/<session>.jsonl)`;
  }
  return base.includes(sessionId) ? null : `the transcript's name does not match its session ${sessionId}`;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'apply_patch']);
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'local_shell']);
const ADVANCES = /\bagenfk\s+(verify\b|update\b[^\n]*--status\b)/;

/** Walk a record for tool calls: `{ name, input }` (Claude, pi) or `{ name, arguments }` (Codex). */
function toolCalls(rec: unknown, out: Array<{ name: string; input: any }>, depth = 0): void {
  if (!rec || typeof rec !== 'object' || depth > 8) return;
  if (Array.isArray(rec)) { for (const x of rec) toolCalls(x, out, depth + 1); return; }
  const o = rec as any;
  if (typeof o.name === 'string' && (o.input !== undefined || o.arguments !== undefined)) {
    let input = o.input ?? o.arguments;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
    out.push({ name: o.name, input: input ?? {} });
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') toolCalls(v, out, depth + 1);
}

/** Largest transcript read, so a huge file cannot pin the server. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Read a transcript's identity. Throws with a message fit for the caller when
 * the file is outside the harness folders or names no session.
 */
export function readTranscriptIdentity(file: string): TranscriptIdentity {
  if (typeof file !== 'string' || !file.trim()) throw new Error('transcript is required: the path of the reviewer\'s session log');
  const where = transcriptRoot(file);
  if (!where) throw new Error(`${file} is not a transcript in a harness session folder (~/${ROOTS.map(r => r.rel).join(', ~/')})`);
  // Built from the resolved harness folder and the path inside it, and
  // checked to stay inside it: the file read is the one transcriptRoot vetted.
  // transcriptRoot already refuses an escape, so the guard never fires today;
  // it is kept as the resolve-then-startsWith check static analysis recognises.
  const real = path.resolve(where.root, where.rel);
  if (!real.startsWith(where.root + path.sep)) throw new Error(`${file} is not a transcript in a harness session folder`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error(`${file} is larger than ${MAX_TRANSCRIPT_BYTES} bytes`);
  let sessionId: string | null = null;
  let agentId: string | null = null;
  let lastAt: string | null = null;
  const calls: Array<{ name: string; input: any }> = [];
  for (const raw of fs.readFileSync(real, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    toolCalls(rec, calls);
    if (!sessionId) {
      if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
      else if (rec.type === 'session' && typeof rec.id === 'string') sessionId = rec.id;
      else if (rec.type === 'session_meta' && typeof rec.payload?.id === 'string') sessionId = rec.payload.id;
    }
    if (!agentId && rec.isSidechain === true && typeof rec.agentId === 'string') agentId = rec.agentId;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (ts && !Number.isNaN(Date.parse(ts)) && (!lastAt || Date.parse(ts) > Date.parse(lastAt))) lastAt = ts;
  }
  if (!sessionId) throw new Error(`${file} names no session: it is not a transcript`);
  const layout = layoutError(where, sessionId, agentId);
  if (layout) throw new Error(`${file}: ${layout}`);
  const edits = [...new Set(calls.filter(c => EDIT_TOOLS.has(c.name))
    .map(c => c.input?.file_path ?? c.input?.path ?? c.input?.notebook_path)
    .filter((f): f is string => typeof f === 'string'))];
  const commandOf = (c: { input: any }) => (Array.isArray(c.input?.command) ? c.input.command.join(' ') : c.input?.command);
  const advancedCards = calls.some(c => SHELL_TOOLS.has(c.name) && typeof commandOf(c) === 'string' && ADVANCES.test(commandOf(c)));
  return { client: where.client, sessionId, agentId, transcript: real, lastAt, mtime: st.mtime.toISOString(), edits, advancedCards };
}

/** Findings as recorded: each fixed, or rejected with a reason. Throws on anything else. */
export function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) throw new Error('findings must be a list of { title, state: fixed|rejected, reason? } (an empty list when the review found nothing)');
  return value.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`finding ${i + 1} must be an object`);
    const { title, state, reason } = f as any;
    if (typeof title !== 'string' || !title.trim()) throw new Error(`finding ${i + 1} needs a title`);
    if (state !== 'fixed' && state !== 'rejected') throw new Error(`finding '${title}' must be fixed or rejected (was ${JSON.stringify(state)})`);
    if (state === 'rejected' && (typeof reason !== 'string' || !reason.trim())) throw new Error(`finding '${title}' is rejected without a reason`);
    return { title, state, ...(typeof reason === 'string' && reason.trim() ? { reason } : {}) };
  });
}

/** An author identity reported on verify, or null when it is not one. */
export function parseActor(value: unknown): Identity | null {
  if (!value || typeof value !== 'object') return null;
  const { client, sessionId, agentId } = value as any;
  if (typeof client !== 'string' || !client.trim() || typeof sessionId !== 'string' || !sessionId.trim()) return null;
  return { client, sessionId, agentId: typeof agentId === 'string' && agentId.trim() ? agentId : null };
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The author the harness that launched this process names (BUG e78e78d2): the
 * MCP validate path used to read only Claude Code's variable, so a Codex
 * author left no identity and a self-review passed with a warning.
 */
export function actorFromEnv(env: NodeJS.ProcessEnv = process.env): { client: string; sessionId: string } | undefined {
  const claude = env.CLAUDE_CODE_SESSION_ID;
  if (typeof claude === 'string' && SESSION_ID.test(claude)) return { client: 'claude-code', sessionId: claude };
  const codex = env.CODEX_THREAD_ID;
  if (typeof codex === 'string' && SESSION_ID.test(codex)) return { client: 'codex', sessionId: codex };
  return undefined;
}
