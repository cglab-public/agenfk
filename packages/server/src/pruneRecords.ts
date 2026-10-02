/**
 * The upgrade's prune of existing cards' step records (TASK 6f774968, BUG
 * ec325925). Cards written before the retention rule carry every capture they
 * ever took (each the whole suite's per-test results) and an inline
 * authoredTests list of every test name. Run on the server's start - the
 * restart after `agenfk upgrade` - and idempotent, so later starts find
 * nothing to do:
 *  - every card gets the runtime rule (recordRetention): the latest capture of
 *    each step and its latest green; only greens among rolled-back ones. A
 *    closed card included: DONE, ARCHIVED and TRASHED can all be reopened, and
 *    a rollback takes no new capture, so the entry baseline its next verify
 *    reads must still be there (epic review);
 *  - every record that is not a capture is kept;
 *  - an inline authoredTests list becomes a reference to its capture while
 *    that capture is still on the card (authoredRecord);
 *  - then the blobs nothing references any more are swept.
 * Decided on the light row (results left as blob references): a failed run's
 * exit code and broken files are on it, so a card is read whole only to turn
 * its inline authoredTests list into a reference - once.
 * Rows are rewritten as housekeeping: the card's updatedAt and history stay.
 */
import type { StorageProvider } from '@agenfk/core';
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

export async function pruneStepRecords(storage: StorageProvider): Promise<PruneReport> {
  const report: PruneReport = { cards: 0, records: 0, authored: 0, blobs: 0 };
  if (!storage.rewriteRecords) return report;
  for (const light of await storage.listItems({ hydrate: false })) {
    let records: any[] = (light as any).stepRecords ?? [];
    const superseded: any[] = (light as any).supersededRecords ?? [];
    let converted = 0;
    if (records.some(isInlineAuthored)) {
      // Its capture's results are needed to tell the list is exactly theirs.
      const whole: any = await storage.getItem(light.id);
      ({ records, converted } = compactAuthoredLists(whole?.stepRecords ?? []));
    }
    const stepRecords = retainCaptures(records);
    const keptSuperseded = retainSuperseded(superseded);
    const dropped = records.length - stepRecords.length + superseded.length - keptSuperseded.length;
    if (!dropped && !converted) continue;
    await storage.rewriteRecords(light.id, {
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
