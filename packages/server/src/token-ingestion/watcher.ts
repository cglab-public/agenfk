import * as fs from 'fs';
import * as path from 'path';
import type { Project, TokenEvent, IngestionState, StorageProvider } from '@agenfk/core';
import { findActiveItemAt } from './attribution';

/**
 * What a parser may carry from one pass to the next. The watcher saves
 * `state` as JSON on the file's ingestion state and hands it back on the next
 * pass, so a parser that needs context from earlier lines (Codex's session
 * id and running totals, pi's session header) can resume mid-file instead of
 * the watcher re-reading a file that can be tens of megabytes.
 */
export interface ParserContext {
  state?: unknown;
}

/**
 * Parser signature: given the text of a slice of a session log, the file path
 * and the byte offset where the slice starts, return the TokenEvents to
 * insert, with `sourceOffset` set to each record's byte offset in the file.
 * `ctx.state` is what the parser saved after its previous pass (undefined on
 * a fresh start); it may replace it with whatever it needs next time.
 */
export type SessionLogParser = (
  text: string,
  sourcePath: string,
  baseOffset: number,
  ctx?: ParserContext,
) => TokenEvent[];

export interface ProcessFileResult {
  events: TokenEvent[];
  nextState: IngestionState;
}

/** How a pass over a file starts, given what was saved after the last one. */
interface PassPlan {
  /** Bytes before this are already ingested. */
  start: number;
  /** Where the parser must start reading for context (0 when rebuilding). */
  parseFrom: number;
  state: unknown;
}

function planPass(prior: IngestionState | null, fileSize: number): PassPlan {
  if (!prior || prior.lastOffset > fileSize) return { start: 0, parseFrom: 0, state: undefined }; // new or truncated
  if (prior.parserState !== undefined) {
    try {
      const state = JSON.parse(prior.parserState);
      return { start: prior.lastOffset, parseFrom: prior.lastOffset, state: state ?? undefined };
    } catch { /* unreadable: rebuild below */ }
  }
  // Saved before parser state existed (or unreadable): rebuild context from
  // the top once; only events at or after lastOffset are new.
  return { start: prior.lastOffset, parseFrom: 0, state: undefined };
}

/**
 * The pass itself, over `buf`, which holds the file's bytes from `bufStart`
 * on. Only COMPLETE lines are consumed: a line still being written is left
 * for the next pass, because skipping past it would lose that turn for good.
 */
function processBytes(
  sourcePath: string,
  buf: Buffer,
  bufStart: number,
  plan: PassPlan,
  parser: SessionLogParser,
): ProcessFileResult {
  const lastNewline = buf.lastIndexOf(0x0a);
  const end = Math.max(plan.start, lastNewline === -1 ? bufStart : bufStart + lastNewline + 1);
  const from = plan.parseFrom - bufStart;
  const text = end > plan.parseFrom ? buf.subarray(from, end - bufStart).toString('utf8') : '';
  const ctx: ParserContext = { state: plan.state };
  const events = text
    ? parser(text, sourcePath, plan.parseFrom, ctx).filter((ev) => ev.sourceOffset >= plan.start)
    : [];
  return {
    events,
    nextState: {
      sourcePath,
      lastOffset: end,
      lastRunAt: new Date().toISOString(),
      // Always written, "null" included: its presence is what says the next
      // pass may resume at lastOffset rather than rebuild from the top.
      parserState: JSON.stringify(ctx.state ?? null),
    },
  };
}

/**
 * Pure-logic core of the watcher over a file's whole contents: compares the
 * prior ingestion state with them and returns the new events plus the next
 * state. No I/O; the runtime path reads only the appended bytes instead (see
 * ingestFile), with the same semantics.
 */
export function processFile(
  sourcePath: string,
  currentContents: string,
  priorState: IngestionState | null,
  parser: SessionLogParser,
): ProcessFileResult {
  const buf = Buffer.from(currentContents, 'utf8');
  return processBytes(sourcePath, buf, 0, planPass(priorState, buf.length), parser);
}

// ── Runtime poller (wraps processFile + storage) ─────────────────────────────
// Discovers session log files under one or more root directories and ingests
// them into the storage's token_events table. Picks up where it left off via
// the ingestion_state table.

export interface IngestionSource {
  /** Stable name used as the `client` field on emitted events (e.g. 'codex'). */
  client: string;
  /** Root dir to scan (e.g. ~/.codex/sessions/). */
  rootDir: string;
  /** Glob-like predicate for which files to ingest. */
  matches: (relativePath: string) => boolean;
  /** Per-client parser. */
  parser: SessionLogParser;
}

export interface IngestionPollerOptions {
  storage: StorageProvider;
  sources: IngestionSource[];
  /** ms between polls. Default 30s. */
  intervalMs?: number;
  /** Attribute events to the matching project root and active item. */
  attributeEvents?: boolean;
  /**
   * ISO time ingestion was first switched on. A file last written before it
   * is fast-forwarded to its end without being parsed: those sessions predate
   * the session-to-card journal, so none of their usage could be attributed,
   * and the backlog runs to gigabytes. Turns before it in a file that is still
   * being written are dropped for the same reason.
   */
  epoch?: string;
  /** Limit the pass to some files (flush: only the sessions being counted). */
  fileFilter?: (client: string, absPath: string, relPath: string) => boolean;
  /** Called for each TokenEvent successfully written to storage. */
  onEvent?: (ev: TokenEvent) => void;
}

/**
 * Walks a directory recursively and returns absolute paths matching
 * `predicate`. Asynchronous: the session folders hold thousands of files and
 * this runs on the server's event loop every poll.
 */
export async function listSourceFiles(rootDir: string, predicate: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(rootDir, abs);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && predicate(rel)) out.push(abs);
    }
  }
  return out;
}

/**
 * One file's pass, reading only what it needs: nothing when the file has not
 * grown, only the appended bytes when the parser's state was saved, the whole
 * file only to rebuild context or start a new one.
 */
async function ingestFile(
  abs: string,
  parser: SessionLogParser,
  storage: StorageProvider,
  epochMs: number | null,
): Promise<ProcessFileResult | null> {
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(abs); } catch { return null; }
  const prior = await storage.getIngestionState(abs);
  if (prior && prior.lastOffset === stat.size) return null;

  if (epochMs !== null && stat.mtimeMs < epochMs) {
    // Dropping any parser state makes a later append rebuild context first.
    await storage.setIngestionState({ sourcePath: abs, lastOffset: stat.size, lastRunAt: new Date().toISOString() });
    return null;
  }

  const plan = planPass(prior, stat.size);
  let buf: Buffer;
  try {
    const fh = await fs.promises.open(abs, 'r');
    try {
      const length = stat.size - plan.parseFrom;
      buf = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await fh.read(buf, 0, buf.length, plan.parseFrom);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  return processBytes(abs, buf, plan.parseFrom, plan, parser);
}

/**
 * Single ingestion pass: scan all sources, ingest any new bytes, return the
 * total number of events written.
 */
export async function ingestOnce(opts: IngestionPollerOptions): Promise<number> {
  let written = 0;
  const epochMs = opts.epoch ? Date.parse(opts.epoch) : null;
  for (const source of opts.sources) {
    const files = await listSourceFiles(source.rootDir, source.matches);
    for (const abs of files) {
      if (opts.fileFilter && !opts.fileFilter(source.client, abs, path.relative(source.rootDir, abs))) continue;
      const result = await ingestFile(abs, source.parser, opts.storage, Number.isFinite(epochMs) ? epochMs : null);
      if (!result) continue;
      // Tag every event with the source's client name (parsers may not know it).
      for (const ev of result.events) {
        // A session running across the epoch: its earlier turns predate the
        // journal as much as an old file does, and are dropped the same way.
        // One format for every harness: the store compares times as text.
        const tsMs = Date.parse(ev.ts);
        if (Number.isFinite(tsMs)) ev.ts = new Date(tsMs).toISOString();
        if (epochMs !== null && Number.isFinite(epochMs) && Date.parse(ev.ts) < epochMs) continue;
        ev.client = source.client as any;
        if (opts.attributeEvents) await attributeTokenEvent(opts.storage, ev);
        try {
          await opts.storage.insertTokenEvent(ev);
          written++;
          opts.onEvent?.(ev);
        } catch {
          // A duplicate: the same record on poll overlap (client, source_path,
          // source_offset), or the same turn already ingested from another
          // file (client, dedup_key). Either way it is already counted.
        }
      }
      await opts.storage.setIngestionState(result.nextState);
    }
  }
  return written;
}

/**
 * Charge a turn to a project and, when it can be known, a card (GH-389).
 *
 * A turn with a session id goes to the card the session-to-card journal says
 * that session was on at the turn's time: the gatekeeper and verify write it,
 * and a closed card ends it. No row (the session had not reached a card yet)
 * or an ended row means no card, only the project. The older guess - the card
 * in the project activated most recently - charged one agent's turns to
 * another's card whenever two worked in one project, so it is kept only for a
 * turn with no session id at all.
 */
export async function attributeTokenEvent(storage: StorageProvider, ev: TokenEvent): Promise<void> {
  const project = await findProjectForCwd(storage, ev.cwd);
  if (project) ev.projectId = project.id;

  if (ev.sessionId) {
    const row = await storage.sessionCardAt(ev.client, ev.sessionId, ev.ts);
    if (row?.itemId) {
      ev.itemId = row.itemId;
      if (row.projectId) ev.projectId = row.projectId;
    }
    return;
  }

  if (!project) return;
  const flow = project.flowId ? await storage.getFlow(project.flowId) : null;
  const items = await storage.listItems({ projectId: project.id });
  const itemId = findActiveItemAt(items, flow, ev.ts);
  if (itemId) ev.itemId = itemId;
}

async function findProjectForCwd(storage: StorageProvider, cwd: string | undefined): Promise<Project | null> {
  if (!cwd) return null;
  const projects = await storage.listProjects();
  let best: { project: Project; rootLength: number } | null = null;
  for (const project of projects) {
    if (!project.projectRoot) continue;
    if (!isWithinOrEqual(project.projectRoot, cwd)) continue;
    const rootLength = path.resolve(project.projectRoot).length;
    if (!best || rootLength > best.rootLength) best = { project, rootLength };
  }
  return best?.project ?? null;
}

function isWithinOrEqual(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
