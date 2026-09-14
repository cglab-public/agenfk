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
}

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
  const appended: RunEvent[] = [];

  const runs = await storage.listAgentRuns({ status: 'running' });
  for (const run of runs) {
    if (!run.sourcePath) continue;
    const resolved = resolveSource(run.sourcePath);
    if (!resolved) continue; // pattern matches nothing yet
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
      if (seq === null) continue;
      const stored = { ...event, seq };
      emit({ itemId: run.itemId, runId: run.id, event: stored });
      appended.push(stored);
    }
    if (parsed.length > consumed) {
      await storage.setIngestionState({ sourcePath: offsetKey, lastOffset: parsed.length, lastRunAt: now() });
    }
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
