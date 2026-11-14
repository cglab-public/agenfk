import * as fs from 'fs';
import {
  parseDeadletterLines,
  serializeDeadletterLines,
  selectForRequeue,
  summarizeRequeue,
  deadletterIndicator,
  writePrivateFileSync,
  type RequeueFilters,
  type RequeueSummary,
  type DeadletterIndicator,
} from '@agenfk/core';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';

export interface RequeueResult {
  dryRun: boolean;
  summary: RequeueSummary;
  /** Lines left in the file, counted by why (see selectForRequeue). */
  excluded: Record<string, number>;
  /** Rows inserted into the outbox. */
  requeued: number;
  /** Selected rows the outbox already held (a re-run after a partial one). */
  alreadyQueued: number;
  /** Lines left in the deadletter file. */
  remaining: number;
  eventIds: string[];
}

/**
 * The outbox insert committed but the deadletter rewrite did not. Nothing is
 * lost: every selected event is now in both places, and the same requeue run
 * again finishes the job (the outbox ignores what it already holds, and the
 * hub dedups by eventId).
 */
export class RequeueRewriteFailed extends Error {
  constructor(public readonly inserted: number, public readonly cause: unknown) {
    super(`requeued ${inserted} event(s) into the outbox, but could not rewrite the deadletter file: ${(cause as Error)?.message ?? cause}`);
  }
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Put deadlettered events back in the outbox so the next flush sends them
 * again, with their original eventId, occurredAt and payload (#223).
 *
 * The order is the flusher's in reverse: outbox insert FIRST, deadletter
 * rewrite SECOND, so a failure between them can only duplicate an event,
 * never lose one.
 *
 * Fully synchronous on purpose. The flusher's deadletter append is synchronous
 * too and runs in this same process, so it cannot land between this read and
 * this rewrite and be overwritten. (`agenfk hub deadletter discard` rewrites
 * the file from the CLI process; racing it can at worst undo a discard or keep
 * a requeued line, which the next requeue absorbs.)
 */
export function requeueDeadletter(opts: {
  storage: Pick<SQLiteStorageProvider, 'hubOutboxAppendMany'>;
  filters: RequeueFilters;
  /** The deadletter file: the flusher's defaultDeadletterPath() in production. */
  path: string;
  dryRun?: boolean;
  /**
   * Requeue only these of the selected events: the ones a person confirmed
   * from the dry run. Refusals appended while the prompt was open have not
   * been through the binding check, and wait for the next run.
   */
  onlyEventIds?: string[];
  /** Injectable for tests; the real ones write 0600 via temp + rename. */
  writeFile?: (file: string, data: string) => void;
  removeFile?: (file: string) => void;
}): RequeueResult {
  const file = opts.path;
  const writeFile = opts.writeFile ?? writePrivateFileSync;
  const removeFile = opts.removeFile ?? ((f: string) => fs.rmSync(f, { force: true }));

  const lines = parseDeadletterLines(readFileOrEmpty(file));
  const selection = selectForRequeue(lines, opts.filters);
  const excluded = selection.excluded;
  let selected = selection.selected;
  if (opts.onlyEventIds) {
    const confirmed = new Set(opts.onlyEventIds);
    const unconfirmed = selected.filter(s => !confirmed.has(s.eventId)).length;
    if (unconfirmed > 0) excluded.unconfirmed = unconfirmed;
    selected = selected.filter(s => confirmed.has(s.eventId));
  }
  const result: RequeueResult = {
    dryRun: !!opts.dryRun,
    summary: summarizeRequeue(selected),
    excluded,
    requeued: 0,
    alreadyQueued: 0,
    remaining: lines.length,
    eventIds: selected.map(s => s.eventId),
  };
  if (opts.dryRun || selected.length === 0) return result;

  const inserted = opts.storage.hubOutboxAppendMany(
    selected.map(s => ({ eventId: s.eventId, occurredAt: s.occurredAt, payload: s.payloadJson })),
  );
  const drop = new Set(selected.map(s => s.index));
  const kept = lines.filter((_, i) => !drop.has(i));
  try {
    if (kept.length === 0) removeFile(file);
    else writeFile(file, serializeDeadletterLines(kept));
  } catch (e) {
    throw new RequeueRewriteFailed(inserted, e);
  }
  result.requeued = inserted;
  result.alreadyQueued = selected.length - inserted;
  result.remaining = kept.length;
  return result;
}

let indicatorCache: { file: string; mtimeMs: number; size: number; value: DeadletterIndicator } | null = null;

/**
 * The sticky refusal indicator for the deadletter file. Read on every CLI
 * command (the pre-action banner) and every board poll, so it is cached on the
 * file's mtime and size.
 */
export function readDeadletterIndicator(file: string): DeadletterIndicator {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return deadletterIndicator([]);
  }
  if (indicatorCache && indicatorCache.file === file && indicatorCache.mtimeMs === st.mtimeMs && indicatorCache.size === st.size) {
    return indicatorCache.value;
  }
  const value = deadletterIndicator(parseDeadletterLines(readFileOrEmpty(file)));
  indicatorCache = { file, mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}
