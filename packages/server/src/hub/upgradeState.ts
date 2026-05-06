// Persists the local "last upgrade directive applied" state across server
// restarts. Story 3a of EPIC 541c12b3.
//
// The shape lets Story 3b's boot-time replay reason about a directive whose
// outcome event never reached the hub because the upgrade itself killed the
// emitting process. On boot:
//   - state == null               → nothing to do.
//   - outcome === 'started'       → the previous run never reported back; the
//                                   replay code emits succeeded/failed based
//                                   on whether the new currentVersion matches
//                                   the directive's intent, then clears state.
//   - outcome === 'succeeded'/'failed'
//                                 → already settled; clears state if the hub
//                                   has acknowledged the directive (next poll
//                                   returns 204) or just leaves it in place
//                                   for idempotent re-emit.
//
// File-backed JSON, atomically written via tmp+rename.
import * as fs from 'fs';
import * as path from 'path';

export type UpgradeOutcome = 'started' | 'succeeded' | 'failed';

export interface UpgradeState {
  lastDirectiveId: string;
  outcome: UpgradeOutcome;
  resultVersion?: string;
  error?: string;
  finishedAt?: string;
}

const FILE_NAME = 'upgrade-state.json';

function filePath(dbDir: string): string {
  return path.join(dbDir, FILE_NAME);
}

function isValidState(v: any): v is UpgradeState {
  return (
    v && typeof v === 'object' &&
    typeof v.lastDirectiveId === 'string' && v.lastDirectiveId.length > 0 &&
    (v.outcome === 'started' || v.outcome === 'succeeded' || v.outcome === 'failed')
  );
}

export function readUpgradeState(dbDir: string): UpgradeState | null {
  const p = filePath(dbDir);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeUpgradeState(dbDir: string, state: UpgradeState): void {
  fs.mkdirSync(dbDir, { recursive: true });
  const p = filePath(dbDir);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

export function clearUpgradeState(dbDir: string): void {
  const p = filePath(dbDir);
  try {
    fs.unlinkSync(p);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
}
