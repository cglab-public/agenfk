/**
 * Which step records a card keeps (TASK 81e21940, BUG ec325925).
 *
 * A capture holds the whole suite's per-test results, and nothing ever dropped
 * one: a card in this repo carried four of them (~8 MB hydrated) plus up to 20
 * superseded ones. What reads them is narrower:
 *  - a step's entry baseline is the latest capture of the previous step;
 *  - the rollback refusal reads the latest capture of the step before;
 *  - reuse takes a green whose tree state matches, newest first.
 * So a card keeps the latest capture of each step and its latest green, and a
 * rolled-back capture only if it is a green. Every other kind of record (exits,
 * approvals, overrides, named records) is kept: they are small, and the PR body,
 * reviews and audits read them.
 *
 * This is the rule for an OPEN card, applied on every write. A closed card is
 * reduced further, to its final green, by the startup prune: at close
 * stampCloseGreen still reads the card's own runs.
 */
import type { StorageProvider } from '@agenfk/core';
import { capturedGreen } from './checkEngine';

/** How many rolled-back greens a card keeps for reuse. */
export const SUPERSEDED_KEPT = 20;

const isCapture = (r: any) => r?.kind === 'capture';

export function retainCaptures<T extends any[] | undefined>(records: T): T {
  if (!records) return records;
  const keep = new Set<any>();
  const latestOfStep = new Map<string, any>();
  let latestGreen: any = null;
  for (const r of records) {
    if (!isCapture(r)) continue;
    latestOfStep.set(r.step, r);
    if (capturedGreen(r)) latestGreen = r;
  }
  for (const r of latestOfStep.values()) keep.add(r);
  if (latestGreen) keep.add(latestGreen);
  return records.filter(r => !isCapture(r) || keep.has(r)) as T;
}

export function retainSuperseded<T extends any[] | undefined>(records: T): T {
  if (!records) return records;
  return records.filter(r => capturedGreen(r)).slice(-SUPERSEDED_KEPT) as T;
}

/**
 * The storage, with the rule applied to every record write: one place, so no
 * writer (a capture, a close stamp, a rollback, an approval) can skip it. The
 * records arrive hydrated - writers read the card, then append - so a capture's
 * results are there to judge whether it is a green.
 */
export function withRecordRetention<S extends StorageProvider>(storage: S): S {
  const update = storage.updateItem.bind(storage);
  storage.updateItem = (id, updates) => {
    const u: any = updates;
    if (!u || (!('stepRecords' in u) && !('supersededRecords' in u))) return update(id, updates);
    const retained: any = { ...u };
    if ('stepRecords' in u) retained.stepRecords = retainCaptures(u.stepRecords);
    if ('supersededRecords' in u) retained.supersededRecords = retainSuperseded(u.supersededRecords);
    return update(id, retained);
  };
  return storage;
}
