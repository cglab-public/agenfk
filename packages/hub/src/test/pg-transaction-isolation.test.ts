// PgAdapter transaction routing (BUG c5e8b847).
//
// A PG transaction is tied to a connection, so statements inside one must go to
// a dedicated client. The adapter used to park that client on shared per-adapter
// state, which meant EVERY concurrent request's statements joined whatever
// transaction happened to be open — so a rollback in an admin operation
// discarded unrelated event ingest that ran during it.
//
// Asserted as routing, with a fake pool recording where each query went. Proving
// MVCC isolation under pg-mem would not be faithful: it is one in-memory
// database with no per-connection snapshot.

import { describe, it, expect } from 'vitest';
import { __createPgAdapterForTest } from '../db/postgres';

interface Recorded { via: string; sql: string }

/** A pool whose clients are distinguishable, so routing is observable. */
function makeFakePool() {
  const log: Recorded[] = [];
  /** Which clients were handed back. A client never released is a pool leak. */
  const released: string[] = [];
  let clientSeq = 0;
  const pool: any = {
    query: async (sql: string) => {
      log.push({ via: 'pool', sql });
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      const name = `client-${++clientSeq}`;
      return {
        query: async (sql: string) => {
          log.push({ via: name, sql });
          return { rows: [], rowCount: 0 };
        },
        release: () => { released.push(name); },
      };
    },
  };
  return { pool, log, released };
}

const viasFor = (log: Recorded[], match: string) =>
  log.filter(r => r.sql.includes(match)).map(r => r.via);

describe('PgAdapter transaction routing', () => {
  it('routes statements inside the callback to the transaction client', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    await db.transaction(async () => {
      await db.run('UPDATE inside_tx SET x = 1');
    });

    expect(viasFor(log, 'inside_tx')).toEqual(['client-1']);
    expect(viasFor(log, 'BEGIN')).toEqual(['client-1']);
    expect(viasFor(log, 'COMMIT')).toEqual(['client-1']);
  });

  it('keeps a concurrent statement on the pool while a transaction is open', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    let releaseTx: () => void = () => {};
    const gate = new Promise<void>(r => { releaseTx = r; });

    const tx = db.transaction(async () => {
      await db.run('UPDATE inside_tx SET x = 1');
      await gate; // hold the transaction open
    });
    // This is the ingest that used to be swept into the transaction — and
    // therefore discarded if the transaction later rolled back.
    await db.run('INSERT INTO concurrent_ingest VALUES (1)');
    releaseTx();
    await tx;

    expect(viasFor(log, 'concurrent_ingest')).toEqual(['pool']);
  });

  it('a rolled-back transaction cannot take a concurrent statement with it', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    let releaseTx: () => void = () => {};
    const gate = new Promise<void>(r => { releaseTx = r; });

    const tx = db.transaction(async () => {
      await db.run('UPDATE inside_tx SET x = 1');
      await gate;
      throw new Error('admin operation failed');
    }).catch(() => { /* expected */ });

    await db.run('INSERT INTO concurrent_ingest VALUES (1)');
    releaseTx();
    await tx;

    // ROLLBACK went to the transaction's own client only.
    expect(viasFor(log, 'ROLLBACK')).toEqual(['client-1']);
    expect(viasFor(log, 'concurrent_ingest')).toEqual(['pool']);
  });

  it('two sequential transactions each get their own client', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    await db.transaction(async () => { await db.run('UPDATE first_tx SET x = 1'); });
    await db.transaction(async () => { await db.run('UPDATE second_tx SET x = 1'); });

    expect(viasFor(log, 'first_tx')).toEqual(['client-1']);
    expect(viasFor(log, 'second_tx')).toEqual(['client-2']);
  });

  it('two concurrent transactions do not share a client', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>(r => { releaseA = r; });

    const a = db.transaction(async () => { await db.run('UPDATE tx_a SET x = 1'); await gateA; });
    const b = db.transaction(async () => { await db.run('UPDATE tx_b SET x = 1'); });
    await b;
    releaseA();
    await a;

    const viaA = viasFor(log, 'tx_a');
    const viaB = viasFor(log, 'tx_b');
    expect(viaA).toHaveLength(1);
    expect(viaB).toHaveLength(1);
    expect(viaA[0]).not.toBe(viaB[0]);
    expect(viaA[0]).not.toBe('pool');
    expect(viaB[0]).not.toBe('pool');
  });

  it('nested transactions on the same context are still refused', async () => {
    const { pool } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    await expect(db.transaction(async () => {
      await db.transaction(async () => { /* unreachable */ });
    })).rejects.toThrow(/nested/i);
  });

  it('releases the client so a later transaction is unaffected by a failure', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    await db.transaction(async () => { throw new Error('boom'); }).catch(() => {});
    await db.run('INSERT INTO after_failure VALUES (1)');

    // Statements after a failed transaction must be back on the pool, not stuck
    // on a client whose transaction is dead.
    expect(viasFor(log, 'after_failure')).toEqual(['pool']);
  });

  it('routes exec() the same way as the parameterised helpers', async () => {
    const { pool, log } = makeFakePool();
    const db = __createPgAdapterForTest(pool);

    await db.transaction(async () => { await db.exec('CREATE TABLE inside_exec (x int)'); });
    await db.exec('CREATE TABLE outside_exec (x int)');

    expect(viasFor(log, 'inside_exec')).toEqual(['client-1']);
    expect(viasFor(log, 'outside_exec')).toEqual(['pool']);
  });
});

describe('PgAdapter returns its client to the pool', () => {
  // The failure this guards is the one that takes the hub down: a client not
  // released is a connection gone from the pool for good, and after `max` of
  // them every request hangs waiting for one. The existing "releases the
  // client" test asserts only that a LATER statement routes to the pool, which
  // the AsyncLocalStorage design guarantees whether or not release() ever runs.
  it('on the happy path', async () => {
    const { pool, released } = makeFakePool();
    const db = __createPgAdapterForTest(pool);
    await db.transaction(async () => { await db.run('UPDATE t SET x = 1'); });
    expect(released).toEqual(['client-1']);
  });

  it('when the callback throws', async () => {
    const { pool, released } = makeFakePool();
    const db = __createPgAdapterForTest(pool);
    await expect(db.transaction(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(released).toEqual(['client-1']);
  });

  it('even when the ROLLBACK itself throws', async () => {
    const { pool, released } = makeFakePool();
    const original = pool.connect;
    pool.connect = async () => {
      const client = await original();
      const query = client.query;
      client.query = async (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('connection already gone');
        return query(sql);
      };
      return client;
    };
    const db = __createPgAdapterForTest(pool);
    await expect(db.transaction(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(released).toEqual(['client-1']);
  });

  it('once per transaction, across several', async () => {
    const { pool, released } = makeFakePool();
    const db = __createPgAdapterForTest(pool);
    await db.transaction(async () => { await db.run('UPDATE t SET x = 1'); });
    await db.transaction(async () => { await db.run('UPDATE t SET x = 2'); });
    expect(released).toEqual(['client-1', 'client-2']);
  });
});
