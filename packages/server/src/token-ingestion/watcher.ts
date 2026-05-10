import * as fs from 'fs';
import * as path from 'path';
import type { TokenEvent, IngestionState, StorageProvider } from '@agenfk/core';

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
 * - Normal append: parse only the bytes after lastOffset.
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
  const slice = startOffset === 0 ? currentContents : currentContents.slice(byteOffsetToCharOffset(currentContents, startOffset));
  const events = slice.length ? parser(slice, sourcePath, startOffset) : [];
  return {
    events,
    nextState: {
      sourcePath,
      lastOffset: totalBytes,
      lastRunAt: new Date().toISOString(),
    },
  };
}

/**
 * Convert a byte offset (within the UTF-8 encoding of `s`) to the equivalent
 * character offset for `String.prototype.slice`. Optimized for the common ASCII
 * case where byte offset == char offset.
 */
function byteOffsetToCharOffset(s: string, byteOffset: number): number {
  if (byteOffset === 0) return 0;
  // Fast path: if the prefix is all ASCII, byte offset == char offset.
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const b = Buffer.byteLength(s[i], 'utf8');
    bytes += b;
    if (bytes === byteOffset) return i + 1;
    if (bytes > byteOffset) return i; // mid-codepoint; align to char boundary
  }
  return s.length;
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
        try {
          await opts.storage.insertTokenEvent(ev);
          written++;
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
