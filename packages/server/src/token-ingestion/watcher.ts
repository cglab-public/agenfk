import * as fs from 'fs';
import * as path from 'path';
import { priceTokens, type Project, type TokenEvent, type IngestionState, type StorageProvider, type PricesData } from '@agenfk/core';
import { findActiveItemAt } from './attribution';
import type { TranscriptClaim } from './parsers/claude-code';
import { rechargeAfterClaims, recomputeStoredUsage, transcriptCardOf } from './transcriptCards';
import { totalsOf } from '../usage/stepUsage';

/**
 * What a parser may carry from one pass to the next. The watcher saves
 * `state` as JSON on the file's ingestion state and hands it back on the next
 * pass, so a parser that needs context from earlier lines (Codex's session
 * id and running totals, pi's session header) can resume mid-file instead of
 * the watcher re-reading a file that can be tens of megabytes.
 */
export interface ParserContext {
  state?: unknown;
  /** GH-398: where a parser that reads transcript claims reports them. */
  claims?: TranscriptClaim[];
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
  /** GH-398: the cards the transcript named in this slice (Claude Code only). */
  claims: TranscriptClaim[];
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

function planPass(prior: IngestionState | null, fileSize: number, fileId?: string): PassPlan {
  if (!prior || prior.lastOffset > fileSize) return { start: 0, parseFrom: 0, state: undefined }; // new or truncated
  // Another file now at this path (review finding): its bytes and its session are not the old one's.
  if (fileId && prior.fileId && prior.fileId !== fileId) return { start: 0, parseFrom: 0, state: undefined };
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
): ProcessFileResult & { parsedTo: number } {
  const lastNewline = buf.lastIndexOf(0x0a);
  // How far the parser read (the last complete line in `buf`), and how far
  // the file counts as ingested: never back behind what earlier passes took.
  const parsedTo = lastNewline === -1 ? bufStart : bufStart + lastNewline + 1;
  const end = Math.max(plan.start, parsedTo);
  const from = plan.parseFrom - bufStart;
  const text = parsedTo > plan.parseFrom ? buf.subarray(from, parsedTo - bufStart).toString('utf8') : '';
  const ctx: ParserContext = { state: plan.state, claims: [] };
  const events = text
    ? parser(text, sourcePath, plan.parseFrom, ctx).filter((ev) => ev.sourceOffset >= plan.start)
    : [];
  return {
    events,
    claims: ctx.claims ?? [],
    parsedTo,
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
  const { events, claims, nextState } = processBytes(sourcePath, buf, 0, planPass(priorState, buf.length), parser);
  return { events, claims, nextState };
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
  /**
   * GH-398: whether the turns of the file at this path are charged by the
   * transcript's own claims rather than the session journal (a Claude Code
   * session with subagents, whose journal rows all carry the parent's id).
   */
  ownClaims?: (absPath: string) => Promise<boolean>;
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
  /** Bytes read per chunk of a file (default 4 MiB); a longer line is read whole. */
  chunkBytes?: number;
  /** Limit the pass to some files (flush: only the sessions being counted). */
  fileFilter?: (client: string, absPath: string, relPath: string) => boolean;
  /** Called for each TokenEvent successfully written to storage. */
  onEvent?: (ev: TokenEvent) => void;
  /**
   * GH-397: the price table to price turns with that their harness did not
   * price. Read at most once per pass, and only when a turn needs it; null or
   * a failure leaves those turns unpriced.
   */
  prices?: () => Promise<PricesData | null>;
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

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Which file, and which generation of it, is at the path: device:inode#n.
 * A truncated file keeps its inode but starts its offsets over, so it is a new
 * generation (review finding): its turns must not collide with the old
 * contents' offsets in the dedup index.
 */
function fileGeneration(prior: IngestionState | null, inode: string, size: number): string {
  const [priorInode, priorGen] = (prior?.fileId ?? '').split('#');
  if (priorInode !== inode) return `${inode}#0`;
  const gen = Number(priorGen) || 0;
  return prior && prior.lastOffset > size ? `${inode}#${gen + 1}` : `${inode}#${gen}`;
}

/**
 * One file's pass, reading only what it needs: nothing when the file has not
 * grown, only the appended bytes when the parser's state was saved, the whole
 * file only to rebuild context or start a new one - and never all at once.
 *
 * It reads in chunks and yields each chunk's result for the caller to store
 * before the next is read (review finding): a session log runs to tens of
 * megabytes, and reading one whole, then parsing it in one go, held the
 * server's event loop and all of it in memory. A chunk ends at its last
 * complete line; a line longer than a chunk is read whole.
 */
async function* ingestFile(
  abs: string,
  parser: SessionLogParser,
  storage: StorageProvider,
  epochMs: number | null,
  chunkBytes: number,
): AsyncGenerator<ProcessFileResult> {
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(abs); } catch { return; }
  const prior = await storage.getIngestionState(abs);
  const fileId = fileGeneration(prior, `${stat.dev}:${stat.ino}`, stat.size);
  const sameFile = !prior?.fileId || prior.fileId === fileId;
  if (prior && sameFile && prior.lastOffset === stat.size) return;

  if (epochMs !== null && stat.mtimeMs < epochMs) {
    // Dropping any parser state makes a later append rebuild context first.
    await storage.setIngestionState({ sourcePath: abs, lastOffset: stat.size, lastRunAt: new Date().toISOString(), fileId });
    return;
  }

  let plan = planPass(prior, stat.size, fileId);
  // Starting over (truncated or replaced): record that now, before anything is
  // read. A file cut to nothing, or to half a line, consumes no line this pass,
  // and an unsaved reset would let the next pass resume at the OLD offset once
  // the file grows past it, skipping its new beginning (review finding).
  if (prior && plan.start === 0 && prior.lastOffset > 0) {
    await storage.setIngestionState({ sourcePath: abs, lastOffset: 0, lastRunAt: new Date().toISOString(), fileId });
  }
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(abs, 'r'); } catch { return; }
  try {
    let size = chunkBytes;
    while (plan.parseFrom < stat.size) {
      const length = Math.min(size, stat.size - plan.parseFrom);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, plan.parseFrom);
      const atEnd = plan.parseFrom + bytesRead >= stat.size;
      const result = processBytes(abs, buf.subarray(0, bytesRead), plan.parseFrom, plan, parser);
      if (result.parsedTo === plan.parseFrom) {
        if (atEnd || bytesRead === 0) return; // only a line still being written is left
        size *= 2; // a line longer than the chunk: read more of it
        continue;
      }
      size = chunkBytes;
      const next = result.nextState.parserState ? JSON.parse(result.nextState.parserState) : undefined;
      // Rebuilding context ahead of the old offset: nothing there is new, and a
      // state saved now would claim context the parser has not reached yet.
      if (result.parsedTo >= plan.start) {
        yield { events: result.events, claims: result.claims, nextState: { ...result.nextState, fileId } };
      }
      plan = { start: plan.start, parseFrom: result.parsedTo, state: next ?? undefined };
      if (atEnd) return;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Single ingestion pass: scan all sources, ingest any new bytes, return the
 * total number of events written.
 */
export async function ingestOnce(opts: IngestionPollerOptions): Promise<number> {
  let written = 0;
  const epochMs = opts.epoch ? Date.parse(opts.epoch) : null;
  const cards = new CardRefs(opts.storage);
  let table: Promise<PricesData | null> | null = null;
  const tableNow = () => (table ??= (opts.prices ? opts.prices() : Promise.resolve(null)).catch((e: Error) => {
    console.error(`[USAGE] no price table for this pass: ${e.message}`);
    return null;
  }));
  for (const source of opts.sources) {
    const files = await listSourceFiles(source.rootDir, source.matches);
    for (const abs of files) {
      if (opts.fileFilter && !opts.fileFilter(source.client, abs, path.relative(source.rootDir, abs))) continue;
      let ownClaims: boolean | undefined;
      for await (const result of ingestFile(abs, source.parser, opts.storage, Number.isFinite(epochMs) ? epochMs : null, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES)) {
      const newClaims = await recordClaims(opts.storage, source.client, result.claims, cards);
      const recharged = new Set<string>();
      if (opts.attributeEvents && source.ownClaims && newClaims.length) {
        await rechargeAfterClaims(opts.storage, source.client as TokenEvent['client'], newClaims, recharged);
      }
      if (opts.attributeEvents && ownClaims === undefined) ownClaims = source.ownClaims ? await source.ownClaims(abs) : false;
      // Tag every event with the source's client name (parsers may not know it).
      for (const ev of result.events) {
        // A session running across the epoch: its earlier turns predate the
        // journal as much as an old file does, and are dropped the same way.
        // One format for every harness: the store compares times as text.
        const tsMs = Date.parse(ev.ts);
        if (Number.isFinite(tsMs)) ev.ts = new Date(tsMs).toISOString();
        if (epochMs !== null && Number.isFinite(epochMs) && Date.parse(ev.ts) < epochMs) continue;
        ev.client = source.client as any;
        if (result.nextState.fileId) ev.sourceFile = result.nextState.fileId;
        if (opts.attributeEvents) await attributeTokenEvent(opts.storage, ev, { ownClaims });
        if (opts.prices) await priceTokenEvent(ev, tableNow);
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
      if (recharged.size) await recomputeStoredUsage(opts.storage, recharged);
      await opts.storage.setIngestionState(result.nextState);
      // Let the server answer requests between chunks.
      await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  return written;
}

/**
 * GH-398: the cards a transcript may name by a short id, resolved against the
 * store once per pass. A reference that matches no card, or several, is no
 * claim: a guess would charge a transcript to a card it never worked on.
 */
export class CardRefs {
  private items: Promise<Array<{ id: string; projectId: string }>> | null = null;
  private resolved = new Map<string, Promise<{ id: string; projectId: string } | null>>();

  constructor(private storage: StorageProvider) {}

  resolve(ref: string): Promise<{ id: string; projectId: string } | null> {
    const key = ref.toLowerCase();
    let found = this.resolved.get(key);
    if (!found) {
      found = this.lookUp(key);
      this.resolved.set(key, found);
    }
    return found;
  }

  private async lookUp(ref: string): Promise<{ id: string; projectId: string } | null> {
    if (ref.length === 36) {
      const item: any = await this.storage.getItem(ref);
      return item ? { id: item.id, projectId: item.projectId } : null;
    }
    this.items ??= this.storage.listItems().then((all) => all.map((i: any) => ({ id: String(i.id), projectId: String(i.projectId) })));
    const matches = (await this.items).filter((i) => i.id.toLowerCase().startsWith(ref));
    return matches.length === 1 ? matches[0] : null;
  }
}

/**
 * GH-398: store the claims a pass read, each against the card its reference
 * names. A claim takes effect just after its call: the turn that made the call
 * was spent on the previous card, and is charged there whether the reply was
 * read in the same pass or a later one. Returns the claims not recorded before.
 */
export async function recordClaims(
  storage: StorageProvider, client: string, claims: TranscriptClaim[], cards: CardRefs,
): Promise<Array<{ sessionId: string; agentId: string; at: string }>> {
  const recorded: Array<{ sessionId: string; agentId: string; at: string }> = [];
  for (const claim of claims) {
    const tsMs = Date.parse(claim.at);
    if (!claim.sessionId || !Number.isFinite(tsMs)) continue;
    const card = await cards.resolve(claim.itemRef);
    if (!card) continue;
    const at = new Date(tsMs + 1).toISOString();
    const isNew = await storage.recordTranscriptClaim({
      client, sessionId: claim.sessionId, agentId: claim.agentId, itemId: card.id, projectId: card.projectId, at,
    });
    if (isNew) recorded.push({ sessionId: claim.sessionId, agentId: claim.agentId, at });
  }
  return recorded;
}

/**
 * GH-397: price a turn its harness did not price, from the table as it is at
 * ingestion, as `estimatedCostUsd`. A turn the harness priced (pi) is left as
 * reported; a model the table has no price for, or no table, leaves it unpriced.
 */
export async function priceTokenEvent(ev: TokenEvent, table: () => Promise<PricesData | null>): Promise<void> {
  if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd)) return;
  const prices = await table();
  if (!prices) return;
  const t = totalsOf(ev);
  const cost = priceTokens(ev.model, { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, prices);
  if (cost !== null && Number.isFinite(cost)) ev.estimatedCostUsd = cost;
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
 *
 * GH-398: a subagent's turn, and every turn of a transcript whose session has
 * subagents (`ownClaims`), goes by the transcript's own claims instead: the
 * journal is keyed by session, and a subagent's calls carry its parent's.
 */
export async function attributeTokenEvent(storage: StorageProvider, ev: TokenEvent, opts: { ownClaims?: boolean } = {}): Promise<void> {
  const project = await findProjectForCwd(storage, ev.cwd);
  if (project) ev.projectId = project.id;

  if (ev.sessionId) {
    const row = ev.agentId || opts.ownClaims
      ? (await transcriptCardOf(storage, ev.client, ev.sessionId, ev.agentId ?? '', ev.ts)).card
      : await storage.sessionCardAt(ev.client, ev.sessionId, ev.ts);
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
