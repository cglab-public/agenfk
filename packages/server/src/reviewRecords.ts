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
  /** The latest timestamp in the transcript: when it was last written. */
  lastAt: string | null;
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
export function transcriptRoot(file: string): { client: string } | null {
  const real = realOr(path.resolve(file));
  if (!real) return null;
  for (const r of ROOTS) {
    const root = realOr(path.join(os.homedir(), r.rel));
    if (!root) continue;
    const rel = path.relative(root, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { client: r.client };
  }
  return null;
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
  const real = fs.realpathSync(path.resolve(file));
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error(`${file} is larger than ${MAX_TRANSCRIPT_BYTES} bytes`);
  let sessionId: string | null = null;
  let agentId: string | null = null;
  let lastAt: string | null = null;
  for (const raw of fs.readFileSync(real, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
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
  return { client: where.client, sessionId, agentId, transcript: real, lastAt };
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
