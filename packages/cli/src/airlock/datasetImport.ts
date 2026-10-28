/**
 * DS-3: `agenfk airlock dataset import` - past pi and OpenCode sessions into the hub's
 * Airlock dataset. Only when a person runs it (user decision 2026-10-28: never because
 * the switch was turned on), only while this installation is joined to a hub whose
 * switch is on (the server says so, and refuses otherwise), and never from inside a
 * sandbox (the server refuses that too).
 *
 * The logs are read here: pi's session JSONLs (streamed, a line past MAX_LINE_BYTES
 * skipped), and OpenCode's database read-only - its session, message and part tables,
 * nothing else in it. Both are streamed: memory holds one batch, not the archive. Each
 * call is sent whole with the model it was made with (a batch never mixes two), so the
 * server judges exactly what ran; a call too large for one request is skipped and
 * counted. The server judges them under the current policy, joins them to a card,
 * removes secrets and sends them as rows whose id is derived from the call, so importing
 * again adds nothing - which is also what makes a failed import safe to run again.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linesOf, sessionFiles, MAX_LINE_BYTES } from './learnImport';

// node:sqlite is built into Node 22 (this CLI's floor); its types are not in the
// CLI's @types/node, so it is required with the little of its shape used here,
// as packages/storage-sqlite does.
interface ReadOnlyDb { prepare(sql: string): { iterate(): Iterable<unknown> }; close(): void }
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => ReadOnlyDb };

/** Calls per request, and the most bytes one may carry (the server's /airlock body limit is 256 KB). */
export const DATASET_IMPORT_BATCH = 200;
const BATCH_BYTES = 200 * 1024;
/** A session id or model name longer than this is not one: the session is skipped, the model dropped. */
const MAX_META_CHARS = 200;

export const defaultOpenCodeDb = (): string => path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

export interface ImportCall { callId: string; tool: string; args: Record<string, unknown>; at: string }
export interface ImportSession { client: 'pi' | 'opencode'; sessionId: string; model: string | null; calls: ImportCall[] }
/** One call as it is read: its session and the model it was made with. */
interface ReadCall { client: 'pi' | 'opencode'; sessionId: string; model: string | null; call: ImportCall }

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An ISO time, or null: a number that is no date (1e20) is null too, never a throw. */
const iso = (v: unknown): string | null => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const metaOrNull = (v: string | null): string | null => (v && v.length <= MAX_META_CHARS ? v : null);

/** A pi session file's tool calls as they are read, each with the model selected when it was made. */
async function* piCalls(file: string): AsyncGenerator<ReadCall> {
  let sessionId: string | null = null;
  let model: string | null = null;
  for await (const line of linesOf(file, MAX_LINE_BYTES, () => undefined)) {
    if (!line || line[0] !== '{') continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (!isObject(r)) continue;
    if (r.type === 'session' && typeof r.id === 'string' && !sessionId) {
      if (r.id.length > MAX_META_CHARS) return;
      sessionId = r.id;
    } else if (r.type === 'model_change' && typeof r.modelId === 'string') model = metaOrNull(typeof r.provider === 'string' ? `${r.provider}/${r.modelId}` : r.modelId);
    else if (sessionId && r.type === 'message' && isObject(r.message) && r.message.role === 'assistant' && Array.isArray(r.message.content)) {
      const at = iso(r.timestamp);
      if (!at) continue;
      for (const part of r.message.content) {
        if (!isObject(part) || part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string' || !isObject(part.arguments)) continue;
        yield { client: 'pi', sessionId, model, call: { callId: part.id, tool: part.name, args: part.arguments, at } };
      }
    }
  }
}

/** Calls grouped into sessions (for the tests and small readers; the import streams). A session's model is its first call's. */
async function collect(calls: AsyncIterable<ReadCall> | Iterable<ReadCall>): Promise<ImportSession[]> {
  const out = new Map<string, ImportSession>();
  for await (const c of calls as AsyncIterable<ReadCall>) {
    const key = `${c.client}:${c.sessionId}:${c.model ?? ''}`;
    const s = out.get(key) ?? { client: c.client, sessionId: c.sessionId, model: c.model, calls: [] };
    s.calls.push(c.call);
    out.set(key, s);
  }
  return [...out.values()];
}

/** One pi session file: its id, the model last selected, and every tool call with its time. Null without a session header. */
export async function readPiSessionCalls(file: string): Promise<ImportSession | null> {
  const sessions = await collect(piCalls(file));
  if (!sessions.length) {
    // a session with no calls still has its id
    for await (const line of linesOf(file, MAX_LINE_BYTES, () => undefined)) {
      try {
        const r = JSON.parse(line);
        if (isObject(r) && r.type === 'session' && typeof r.id === 'string') return { client: 'pi', sessionId: r.id, model: null, calls: [] };
      } catch { /* not JSON */ }
    }
    return null;
  }
  const all = sessions.flatMap(s => s.calls);
  return { client: 'pi', sessionId: sessions[0].sessionId, model: sessions[sessions.length - 1].model, calls: all };
}

/**
 * OpenCode's tool calls, from its database opened read-only and read row by row. Only
 * the part table's tool parts and each one's own message (for the model it was made
 * with) are read; no other table is touched.
 */
function* openCodeCalls(dbPath: string): Generator<ReadCall> {
  if (!fs.existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT p.session_id AS session_id, p.data AS data, p.time_created AS time_created, m.data AS message
         FROM part p LEFT JOIN message m ON m.id = p.message_id
        WHERE p.data LIKE '%"type":"tool"%'
        ORDER BY p.session_id, p.time_created, p.id`,
    ).iterate() as Iterable<{ session_id: string; data: string; time_created: number; message: string | null }>;
    for (const r of rows) {
      let d: any;
      try { d = JSON.parse(r.data); } catch { continue; }
      if (!isObject(d) || d.type !== 'tool' || typeof d.tool !== 'string' || typeof d.callID !== 'string' || !isObject(d.state) || !isObject(d.state.input)) continue;
      const at = iso(isObject(d.state.time) ? d.state.time.start : undefined) ?? iso(r.time_created);
      if (!at) continue;
      let m: any = null;
      try { m = r.message ? JSON.parse(r.message) : null; } catch { m = null; }
      const model = metaOrNull(isObject(m) && typeof m.modelID === 'string' ? (typeof m.providerID === 'string' ? `${m.providerID}/${m.modelID}` : m.modelID) : null);
      if (typeof r.session_id !== 'string' || r.session_id.length > MAX_META_CHARS) continue;
      yield { client: 'opencode', sessionId: r.session_id, model, call: { callId: d.callID, tool: d.tool, args: d.state.input, at } };
    }
  } finally {
    db.close();
  }
}

/** OpenCode's sessions, grouped (a session that changed model is one entry per model). */
export function readOpenCodeCalls(dbPath: string): ImportSession[] {
  const out = new Map<string, ImportSession>();
  for (const c of openCodeCalls(dbPath)) {
    const key = `${c.sessionId}:${c.model ?? ''}`;
    const s = out.get(key) ?? { client: 'opencode' as const, sessionId: c.sessionId, model: c.model, calls: [] };
    s.calls.push(c.call);
    out.set(key, s);
  }
  return [...out.values()];
}

export interface DatasetImportDeps {
  status: () => Promise<{ joined: boolean; enabled: boolean }>;
  post: (body: { client: string; sessionId: string; model: string | null; calls: ImportCall[] }) => Promise<{ sent: number; skipped: number }>;
  log: (message: string) => void;
}

export interface DatasetImportResult { sessions: number; sent: number; skipped: number; tooLarge: number }

/** An import that stopped: what it had sent, and where it stopped. */
export class DatasetImportError extends Error {
  constructor(message: string, readonly progress: DatasetImportResult) {
    super(message);
    this.name = 'DatasetImportError';
  }
}

export async function runDatasetImport(
  opts: { piDir: string | null; openCodeDb: string | null },
  d: DatasetImportDeps,
): Promise<DatasetImportResult> {
  const status = await d.status();
  if (!status.joined) throw new Error('This installation is not joined to a hub, so there is no Airlock dataset to import into.');
  if (!status.enabled) throw new Error("On your organization's hub the Airlock dataset switch is off, so nothing was imported. An org admin switches it on (Admin -> Airlock -> Dataset).");
  const done: DatasetImportResult = { sessions: 0, sent: 0, skipped: 0, tooLarge: 0 };
  // One batch at a time: one session, one model, at most DATASET_IMPORT_BATCH calls and BATCH_BYTES.
  let batch: { client: string; sessionId: string; model: string | null; calls: ImportCall[]; bytes: number } | null = null;
  let lastSession: string | null = null;
  const flush = async () => {
    if (!batch || !batch.calls.length) { batch = null; return; }
    const b = batch;
    batch = null;
    try {
      const out = await d.post({ client: b.client, sessionId: b.sessionId, model: b.model, calls: b.calls });
      done.sent += out.sent;
      done.skipped += out.skipped;
    } catch (e) {
      const why = (e as any)?.response?.data?.message || (e as any)?.response?.data?.error || (e as Error)?.message || String(e);
      throw new DatasetImportError(
        `The import stopped at ${b.client} session ${b.sessionId} (${why}). Sent before it: ${done.sent} call${done.sent === 1 ? '' : 's'} from ${done.sessions - 1} earlier session${done.sessions - 1 === 1 ? '' : 's'}; whether that last batch arrived is unknown. Importing again is safe: a call already sent is not added twice.`,
        // The sessions before this one: this one did not finish.
        { ...done, sessions: Math.max(0, done.sessions - 1) },
      );
    }
  };
  const take = async (c: ReadCall) => {
    const sessionKey = `${c.client}:${c.sessionId}`;
    if (sessionKey !== lastSession) {
      await flush();
      lastSession = sessionKey;
      done.sessions++;
      d.log(`${c.client} session ${c.sessionId}`);
    }
    // Whole, never cut: the server judges what ran. A call no request can carry is skipped.
    const size = Buffer.byteLength(JSON.stringify(c.call), 'utf8');
    if (size > BATCH_BYTES) { done.tooLarge++; return; }
    if (batch && (batch.model !== c.model || batch.calls.length >= DATASET_IMPORT_BATCH || batch.bytes + size > BATCH_BYTES)) await flush();
    // The request's own fields count too: client, session id and model (each bounded above).
    if (!batch) batch = { client: c.client, sessionId: c.sessionId, model: c.model, calls: [], bytes: Buffer.byteLength(JSON.stringify({ client: c.client, sessionId: c.sessionId, model: c.model, calls: [] }), 'utf8') };
    batch.calls.push(c.call);
    batch.bytes += size;
  };
  /** A log that cannot be read stops the import like a failed request: with what was sent. */
  const reading = async (source: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      if (e instanceof DatasetImportError) throw e;
      throw new DatasetImportError(
        `The import could not read ${source} (${(e as Error)?.message ?? e}). Sent before it: ${done.sent} call${done.sent === 1 ? '' : 's'} from ${done.sessions} session${done.sessions === 1 ? '' : 's'}. Importing again is safe: a call already sent is not added twice.`,
        { ...done },
      );
    }
  };
  if (opts.piDir) {
    for (const file of sessionFiles(opts.piDir)) {
      await reading(file, async () => {
        for await (const c of piCalls(file)) await take(c);
        await flush();
      });
      lastSession = null;
    }
  }
  const openCodeDb = opts.openCodeDb;
  if (openCodeDb) {
    await reading(openCodeDb, async () => {
      for (const c of openCodeCalls(openCodeDb)) await take(c);
      await flush();
    });
  }
  return done;
}
