import * as fs from 'fs';
import * as path from 'path';
import type { Project, TokenEvent, IngestionState, StorageProvider } from '@agenfk/core';
import { findActiveItemAt } from './attribution';

/**
 * Parser signature: given the new (un-ingested) text content from a file,
 * the file path, and the byte offset where this slice starts, return the
 * TokenEvents to insert. Each parser is responsible for its own per-client
 * format (Codex, Claude Code, etc.) and for setting `sourceOffset` on each
 * event to the byte offset of the record within the file (so the dedup
 * unique index in storage rejects double-inserts on retry).
 */
export type SessionLogParser = (
  text: string,
  sourcePath: string,
  baseOffset: number,
) => TokenEvent[];

export interface ProcessFileResult {
  events: TokenEvent[];
  nextState: IngestionState;
}

/**
 * Pure-logic core of the watcher. Compares prior ingestion state against the
 * file's current contents and returns the new events plus the next state.
 *
 * - First run (no prior state): parse the entire file from offset 0.
 * - Normal append: parse the full file for parser context, return only events
 *   at or after lastOffset.
 * - File truncation/rotation (currentSize < lastOffset): treat as a fresh
 *   file, parse from 0.
 *
 * No I/O is performed here — caller passes the current contents in. Tests
 * exercise this directly without touching the filesystem.
 */
export function processFile(
  sourcePath: string,
  currentContents: string,
  priorState: IngestionState | null,
  parser: SessionLogParser,
): ProcessFileResult {
  const totalBytes = Buffer.byteLength(currentContents, 'utf8');
  const lastOffset = priorState?.lastOffset ?? 0;
  const startOffset = lastOffset > totalBytes ? 0 : lastOffset; // truncation
  // Parse the full file so parsers can use session-level metadata that may
  // appear before the newly appended byte range; then keep only new events.
  const events = currentContents.length
    ? parser(currentContents, sourcePath, 0).filter((ev) => ev.sourceOffset >= startOffset)
    : [];
  return {
    events,
    nextState: {
      sourcePath,
      lastOffset: totalBytes,
      lastRunAt: new Date().toISOString(),
    },
  };
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
  /** Called for each TokenEvent successfully written to storage. */
  onEvent?: (ev: TokenEvent) => void;
}

/**
 * Walks a directory recursively and yields absolute paths matching `predicate`.
 * Used at runtime by the poller; not invoked by the pure tests.
 */
export function listSourceFiles(rootDir: string, predicate: (rel: string) => boolean): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
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
 * Single ingestion pass: scan all sources, ingest any new bytes, return the
 * total number of events written.
 */
export async function ingestOnce(opts: IngestionPollerOptions): Promise<number> {
  let written = 0;
  for (const source of opts.sources) {
    const files = listSourceFiles(source.rootDir, source.matches);
    for (const abs of files) {
      let contents: string;
      try { contents = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const prior = await opts.storage.getIngestionState(abs);
      const result = processFile(abs, contents, prior, source.parser);
      // Tag every event with the source's client name (parsers may not know it).
      for (const ev of result.events) {
        ev.client = source.client as any;
        if (opts.attributeEvents) await attributeTokenEvent(opts.storage, ev);
        try {
          await opts.storage.insertTokenEvent(ev);
          written++;
          opts.onEvent?.(ev);
        } catch {
          // Most likely a duplicate via the unique (client, source_path, source_offset)
          // index — safe to ignore on poll-overlap.
        }
      }
      await opts.storage.setIngestionState(result.nextState);
    }
  }
  return written;
}

export function startIngestionPoller(opts: IngestionPollerOptions): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await ingestOnce(opts); } catch (e) {
      console.error('[TOKEN_INGESTION] tick failed:', (e as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer: NodeJS.Timeout = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

async function attributeTokenEvent(storage: StorageProvider, ev: TokenEvent): Promise<void> {
  const project = await findProjectForCwd(storage, ev.cwd);
  if (!project) return;

  ev.projectId = project.id;
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
