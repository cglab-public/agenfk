/**
 * Regression cover for a trap the parity suite CANNOT reach.
 *
 * Under Postgres the `pg` driver returns COUNT(*) as a STRING, because bigint
 * is not safe for the JS Number type. pg-mem returns a JS number, so the
 * dual-backend parity suite cannot demonstrate this — which is not the same
 * as it being undemonstrable. The same stub-driver technique that pins
 * countUsers() (see countUsers-bigint-coercion.test.ts) reaches it exactly.
 *
 * What breaks without the coercion, on the backend that actually runs:
 * `base.pending += n` becomes `0 + '2' === '02'`, so `counts.pending === 0`
 * is never true, `completed` never goes true, and the dispatch sits `pending`
 * on the parent's board forever while the child re-reports every tick.
 */
import { describe, it, expect } from 'vitest';
import { reportUpgradeProgress } from '../services/federation/upgradeProgress';
import type { HubDb } from '../db/types';

const PARENT_BINDING = 'federation.parent';

/**
 * A driver that answers like `pg`: every COUNT comes back as a string.
 * Everything else is the minimum the reporting pass reads.
 */
const pgShapedDb = (targets: Array<{ state: string; n: string }>): HubDb & { queued: any[] } => {
  const queued: any[] = [];
  const db: any = {
    queued,
    async run(sql: string, params: unknown[] = []) {
      if (/INSERT INTO federation_outbox/i.test(sql)) queued.push(params);
      return { changes: 1 };
    },
    async get(sql: string) {
      // outboxAccepting reads the binding; an active one lets the report queue.
      if (/system_state/i.test(sql)) return { value: JSON.stringify({ state: 'active', encToken: 'x', parentUrl: 'https://p' }) };
      if (/COUNT\(\*\)/i.test(sql)) return { n: '0' };
      return undefined;
    },
    async all(sql: string) {
      if (/FROM upgrade_dispatch_fanout/i.test(sql)) {
        return [{
          dispatch_id: 'd-1', outcome: 'applied', directive_id: 'updisp-d-1',
          skipped_json: '[]', reported_seq: '0', reported_json: null,
        }];
      }
      if (/FROM upgrade_directive_targets/i.test(sql)) return targets;
      return [];
    },
    async exec() {},
    async transaction(fn: any) { return fn(); },
    async close() {},
  };
  return db;
};

const payloadOf = (db: { queued: any[] }) => {
  const row = db.queued.find(p => String(p[2]).includes('fleet:upgrade-dispatch:progress'));
  return JSON.parse(String(row[2])).event.payload;
};

describe('upgrade progress — bigint-as-string coercion', () => {
  it('counts a string-shaped COUNT (pg behaviour) as a number', async () => {
    const db = pgShapedDb([{ state: 'succeeded', n: '2' }, { state: 'pending', n: '1' }]);
    expect(await reportUpgradeProgress(db, 'org')).toBe(1);

    const p = payloadOf(db);
    expect(p.counts.updated).toBe(2);
    expect(p.counts.pending).toBe(1);
    // Not '02' or '01': string concatenation is the actual failure shape.
    expect(typeof p.counts.updated).toBe('number');
    expect(typeof p.counts.pending).toBe('number');
  });

  it('still reaches completion when the driver returns strings', async () => {
    // The consequence that matters. With string counts, `pending === 0` never
    // holds and the dispatch never completes — the parent's board would show
    // it running forever for a fleet that finished.
    const db = pgShapedDb([{ state: 'succeeded', n: '3' }]);
    await reportUpgradeProgress(db, 'org');

    const p = payloadOf(db);
    expect(p.counts.pending).toBe(0);
    expect(p.completed).toBe(true);
  });

  it('sums several string-shaped buckets into the failed count', async () => {
    const db = pgShapedDb([
      { state: 'failed', n: '2' },
      { state: 'cancelled', n: '1' },
      { state: 'succeeded', n: '1' },
    ]);
    await reportUpgradeProgress(db, 'org');
    expect(payloadOf(db).counts.failed).toBe(3);
  });
});
