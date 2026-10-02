/**
 * The upgrade's prune of existing cards' step records (TASK 6f774968, BUG
 * ec325925). Cards written before the retention rule carry every capture they
 * ever took (each the whole suite's per-test results) and an inline
 * authoredTests list of every test name. Run on the server's start - the
 * restart after `agenfk upgrade` - and idempotent, so later starts find
 * nothing to do:
 *  - an open card gets the runtime rule (recordRetention): the latest capture
 *    of each step and its latest green; only greens among rolled-back ones;
 *  - a closed card keeps only its final green: its close has re-stamped it,
 *    and nothing reads the rest. Its rolled-back captures go too;
 *  - every record that is not a capture is kept;
 *  - an inline authoredTests list becomes a reference to its capture while
 *    that capture is still on the card (authoredRecord);
 *  - then the blobs nothing references any more are swept.
 * Rows are rewritten as housekeeping: the card's updatedAt and history stay.
 */
import type { StorageProvider } from '@agenfk/core';
import { capturedGreen } from './checkEngine';
import { retainCaptures, retainSuperseded } from './recordRetention';
import { compactAuthored } from './authoredRecord';

export interface PruneReport {
  /** Cards whose records were rewritten. */
  cards: number;
  /** Records dropped, rolled-back ones included. */
  records: number;
  /** Inline authoredTests lists turned into references. */
  authored: number;
  /** Results blobs freed. */
  blobs: number;
}

const isCapture = (r: any) => r?.kind === 'capture';
const isInlineAuthored = (r: any) => r?.kind === 'record' && r.name === 'authoredTests' && Array.isArray(r.value);

/** A closed card: its final green, and every record that is not a capture. */
function retainClosed(records: any[]): any[] {
  const finalGreen = [...records].reverse().find(r => isCapture(r) && capturedGreen(r));
  return records.filter(r => !isCapture(r) || r === finalGreen);
}

/** Whether the row, read without its results, could change at all. */
function mayChange(item: any, closed: boolean): boolean {
  const records: any[] = item.stepRecords ?? [];
  const captures = records.filter(isCapture);
  if (records.some(isInlineAuthored)) return true;
  if ((item.supersededRecords ?? []).length) return true;
  // A failed run's exit code is on the row: a closed card's lone red capture goes too.
  if (closed) return captures.length > 1 || captures.some(r => r.exitCode !== 0);
  return captures.length > new Set(captures.map(r => r.step)).size;
}

/** authoredTests lists, by reference to the capture of their step taken just before them. */
function compactAuthoredLists(records: any[]): { records: any[]; converted: number } {
  let converted = 0;
  const out = records.map((r, i) => {
    if (!isInlineAuthored(r)) return r;
    const capture = records.slice(0, i).reverse().find(c => isCapture(c) && c.step === r.step);
    if (!capture) return r;
    const compacted = compactAuthored(r.value, capture);
    if (Array.isArray(compacted.value)) return r;
    converted++;
    return { ...r, ...compacted };
  });
  return { records: out, converted };
}

export async function pruneStepRecords(storage: StorageProvider, isClosed: (item: any) => boolean | Promise<boolean>): Promise<PruneReport> {
  const report: PruneReport = { cards: 0, records: 0, authored: 0, blobs: 0 };
  if (!storage.rewriteRecords) return report;
  for (const light of await storage.listItems({ hydrate: false })) {
    const closed = await isClosed(light);
    if (!mayChange(light, closed)) continue;
    // Read whole only now: judging a green needs its results.
    const item: any = await storage.getItem(light.id);
    if (!item) continue;
    const before: any[] = item.stepRecords ?? [];
    const superseded: any[] = item.supersededRecords ?? [];
    const { records: compacted, converted } = compactAuthoredLists(before);
    const stepRecords = closed ? retainClosed(compacted) : retainCaptures(compacted);
    const keptSuperseded = closed ? [] : retainSuperseded(superseded);
    const dropped = before.length - stepRecords.length + superseded.length - keptSuperseded.length;
    if (!dropped && !converted) continue;
    await storage.rewriteRecords(item.id, {
      stepRecords,
      supersededRecords: keptSuperseded.length ? keptSuperseded : undefined,
    });
    report.cards++;
    report.records += dropped;
    report.authored += converted;
  }
  report.blobs = (await storage.sweepUnreferencedBlobs?.()) ?? 0;
  return report;
}
