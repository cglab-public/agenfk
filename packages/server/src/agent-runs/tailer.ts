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

export interface RunEventBroadcast {
  itemId: string;
  runId: string;
  event: RunEvent;
}

export interface TailDeps {
  readFile?: (path: string) => string;   // injectable for tests
  now?: () => string;                     // injectable for tests
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
  const appended: RunEvent[] = [];

  const runs = await storage.listAgentRuns({ status: 'running' });
  for (const run of runs) {
    if (!run.sourcePath) continue;
    let text: string;
    try { text = readFile(run.sourcePath); } catch { continue; } // file not there yet
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
      // Append at end: seq = current total event count, so tailer and REST
      // writers never collide on the (run_id, seq) dedup index.
      const seq = (await storage.listRunEvents(run.id)).length;
      const event: RunEvent = {
        id: uuidv4(),
        runId: run.id,
        seq,
        ts: now(),
        lane: p.lane,
        kind: p.kind,
        tool: p.tool,
        text: p.text,
        payload: p.payload,
        tokens: p.tokens,
      };
      await storage.appendRunEvent(event);
      emit({ itemId: run.itemId, runId: run.id, event });
      appended.push(event);
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
