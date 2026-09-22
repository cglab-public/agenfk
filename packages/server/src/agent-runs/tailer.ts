/**
 * Run tailer — the live half of the Agent Runs feature.
 *
 * Polls the agent_runs whose worker session file (sourcePath) is still being
 * written, re-parses each file, and appends+emits only events not yet seen.
 * Whole-file re-parse + count-based slice keeps it idempotent against the
 * append-only pi session JSONL, so no byte-offset bookkeeping is needed.
 */
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { StorageProvider, RunEvent } from '@agenfk/core';
import { parsePiSessionJsonl } from './pi-parser';
import { resolveSourcePath } from './resolveSource';

export interface RunEventBroadcast {
  itemId: string;
  runId: string;
  event: RunEvent;
}

export interface TailDeps {
  readFile?: (path: string) => string;                    // injectable for tests
  now?: () => string;                                     // injectable for tests
  resolveSource?: (pattern: string) => string | undefined; // injectable for tests
  /**
   * Current size of the source file, or undefined when it cannot be read.
   *
   * Separate from `readFile` on purpose: the cheap question "did it grow?" is
   * asked on every poll, and the expensive read+parse only when it did
   * (CGLAB-188). Undefined means "cannot tell", which must always fall through
   * to reading — never to skipping.
   */
  sizeOf?: (path: string) => number | undefined;          // injectable for tests
  /**
   * runId -> the source last fully consumed. Caller-owned so its lifetime is
   * the tailer's, and so tests do not share state through the module.
   *
   * The PATH is part of the value, not just the size: a run can be re-pointed at
   * a different transcript (PATCH /agent-runs/:id accepts sourcePath), and a glob
   * can resolve to a different file between polls. A memo holding only a byte
   * count would skip a new file that happened to be the same size, forever.
   */
  sizeCache?: Map<string, { path: string; size: number }>;   // injectable for tests
}

/**
 * The memo for the long-lived tailer started by `startRunTailer`.
 *
 * Keyed by run id and pruned each pass, so it is bounded by the runs that are
 * actually running — not by every run the server has ever seen.
 */
const defaultSizeCache = new Map<string, { path: string; size: number }>();

/**
 * One tail pass over all running runs with a source file. Returns the events
 * newly appended this pass (also handed to `emit` as they are persisted).
 */
export async function tailRunsOnce(
  storage: StorageProvider,
  emit: (b: RunEventBroadcast) => void,
  deps: TailDeps = {},
): Promise<RunEvent[]> {
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const now = deps.now ?? (() => new Date().toISOString());
  const resolveSource = deps.resolveSource ?? ((p: string) => resolveSourcePath(p));
  const sizeOf = deps.sizeOf ?? ((p: string): number | undefined => {
    try { return fs.statSync(p).size; } catch { return undefined; }
  });
  const sizeCache = deps.sizeCache ?? defaultSizeCache;
  const appended: RunEvent[] = [];

  const runs = await storage.listAgentRuns({ status: 'running' });
  for (const run of runs) {
    if (!run.sourcePath) continue;
    const resolved = resolveSource(run.sourcePath);
    if (!resolved) continue; // pattern matches nothing yet
    /*
     * Has the file grown since a pass that consumed ALL of it?
     *
     * If not, there is nothing new to parse and the whole read+parse can be
     * skipped. This is the point of the card: the pass used to read and re-parse
     * the entire transcript every 2s, so its cost grew with the session's age.
     *
     * `undefined` (cannot stat) falls through to reading, never to skipping —
     * "cannot tell" must not silently drop events.
     */
    const size = sizeOf(resolved);
    const memo = sizeCache.get(run.id);
    if (size !== undefined && memo !== undefined && memo.path === resolved && memo.size === size) continue;
    let text: string;
    try { text = readFile(resolved); } catch { continue; } // file not there yet
    const parsed = parsePiSessionJsonl(text);
    // Track parser progress SEPARATELY from the run's total event count — the
    // orchestrator also appends events (dispatch/verdict/note) to the same run
    // via REST, so slicing by total count would drop/misalign parser events.
    // Key the offset by run id (distinct from any token-ingestion offsets).
    const offsetKey = `agentrun:${run.id}`;
    const state = await storage.getIngestionState(offsetKey);
    const consumed = state ? state.lastOffset : 0;
    // Where this run's writes start, so the offset can count them.
    const appendedBefore = appended.length;
    // Set when the store refuses a line. A refused pass must NOT be memoised:
    // it deliberately leaves its offset behind, and its retry runs at the same
    // file size — see the cache write below.
    let refused = false;
    for (let i = consumed; i < parsed.length; i++) {
      const p = parsed[i];
      /*
       * The POSITION IS THE STORE'S TO ASSIGN, and taking it back was the bug.
       *
       * This used to compute `seq` as the run's total event count, and the
       * comment above it claimed that was what stopped the tailer and the REST
       * writers colliding on `(run_id, seq)`. It is what caused the collision:
       * count is not MAX+1, and the orchestrator appends to this same run over
       * REST, so a gap is ordinary — after which the count names a slot that
       * already exists and `INSERT OR IGNORE` drops the row.
       *
       * Omitting it hands the job to the atomic `COALESCE(MAX(seq)+1, 0)`
       * inside the insert, which is what it is there for. Order within a batch
       * is preserved because the events are appended one at a time, in
       * transcript order.
       *
       * It also cost a full read of every event on the run, per event, every
       * two seconds — the exact O(n) pattern the storage layer says it
       * replaced with a single indexed aggregate.
       */
      const event: RunEvent = {
        id: uuidv4(),
        runId: run.id,
        ts: now(),
        lane: p.lane,
        kind: p.kind,
        tool: p.tool,
        text: p.text,
        payload: p.payload,
        tokens: p.tokens,
      };
      /*
       * Announce only what was actually written.
       *
       * `appendRunEvent` answers null when the insert wrote nothing, and this
       * caller used to ignore that — so a dropped row was still broadcast to
       * every open panel, painting a line that is gone on the next refresh.
       * Worse, the ingestion offset below advances regardless, so the event is
       * never retried: silent, permanent loss.
       */
      const seq = await storage.appendRunEvent(event);
      if (seq === null) {
        /*
         * STOP, do not skip.
         *
         * The previous version continued, and the offset below still advanced
         * by `parsed.length` — what was READ — so a refused line was passed
         * over on this pass and never reconsidered on any future one. That was
         * the silent permanent loss the commit claimed to have fixed, still
         * intact and now less visible, because the event no longer even
         * appears on screen once.
         *
         * Stopping rather than continuing is the ordering half: writing the
         * lines AFTER a refused one would leave a hole no later pass can fill,
         * since the offset would already be beyond it.
         */
        console.warn(`[agenfk] run ${run.id}: store refused event at ${i}; will retry`);
        refused = true;
        break;
      }
      const stored = { ...event, seq };
      emit({ itemId: run.itemId, runId: run.id, event: stored });
      appended.push(stored);
    }
    /*
     * The offset records what was WRITTEN, not what was read.
     *
     * `consumed + written` rather than `parsed.length`: the two are the same
     * on the happy path and differ exactly when something was refused, which
     * is the case that used to lose events for good.
     */
    const written = appended.length - appendedBefore;
    if (written > 0) {
      await storage.setIngestionState({
        sourcePath: offsetKey, lastOffset: consumed + written, lastRunAt: now(),
      });
    }
    /*
     * Memoised only after a pass that consumed the WHOLE file.
     *
     * A refused pass stops the loop and leaves the offset behind on purpose, so
     * its retry sees the same size. Memoising it would turn "retried until the
     * store recovers" into "lost permanently" — the exact failure the offset
     * work exists to prevent.
     */
    if (!refused && size !== undefined) sizeCache.set(run.id, { path: resolved, size });
  }

  // A run that stopped running must not keep an entry for the life of the
  // server. Cheap, and it bounds the map to the running set.
  if (sizeCache.size > runs.length) {
    const live = new Set(runs.map(r => r.id));
    for (const id of [...sizeCache.keys()]) if (!live.has(id)) sizeCache.delete(id);
  }
  return appended;
}

/**
 * Start the tail poll loop. Returns a stop() to clear the timer.
 * Not started at import time — the server boot path calls this so tests that
 * import `app` never spin a timer.
 */
export function startRunTailer(
  storage: StorageProvider,
  emit: (b: RunEventBroadcast) => void,
  intervalMs = 2000,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await tailRunsOnce(storage, emit); } catch { /* keep polling */ }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer: NodeJS.Timeout = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}
