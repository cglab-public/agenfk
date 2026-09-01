/**
 * Spoke-side org rename support — the local API exposes
 * `POST /internal/hub/rewrite-outbox-org` so `agenfk hub repoint` can rewrite
 * queued outbox payloads in-place when the hub admin renames the org. Without
 * this, the renamed hub rejects every queued event (the orgId baked into each
 * payload no longer matches the API key's org).
 *
 * Behaviour-based: drive the real Express route with supertest and assert on the
 * HTTP responses and the actual effect on the outbox rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./hub-rewrite-outbox-org-test-db.sqlite');
const ROUTE = '/internal/hub/rewrite-outbox-org';

describe('POST /internal/hub/rewrite-outbox-org', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
  beforeEach(async () => { await initStorage(); });

  function queue(orgId: string, id = `ev-${Math.random().toString(36).slice(2)}`) {
    (storage as any).hubOutboxAppend(id, new Date().toISOString(),
      JSON.stringify({ orgId, type: 't', payload: {} }));
  }

  it('rejects with 403 when the internal token is missing/wrong', async () => {
    const res = await request(app).post(ROUTE)
      .set('x-agenfk-internal', 'wrong-token')
      .send({ from: '', to: 'acme' });
    expect(res.status).toBe(403);
  });

  it('rejects with 400 when the target org is empty or body is malformed', async () => {
    const missingTo = await request(app).post(ROUTE)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ from: '' });
    expect(missingTo.status).toBe(400);

    const emptyTo = await request(app).post(ROUTE)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ from: '', to: '' });
    expect(emptyTo.status).toBe(400);
  });

  it('skips malformed-JSON rows instead of aborting the whole UPDATE (json_valid guard, review F7)', async () => {
    // json_extract RAISES "malformed JSON" on a corrupt payload; without the
    // guard one rotten row 500s the entire rewrite the operator confirmed.
    (storage as any).database.prepare('DELETE FROM hub_outbox').run();
    (storage as any).hubOutboxAppend('rot-1', new Date().toISOString(), 'NOT-JSON');
    queue('acme');
    const res = await request(app).post(ROUTE)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ from: 'acme', to: 'acme2' });
    expect(res.status).toBe(200);
    expect(res.body.rewritten).toBe(1);
    const rows = (storage as any).database.prepare('SELECT payload FROM hub_outbox WHERE event_id = ?').get('rot-1');
    expect(rows.payload).toBe('NOT-JSON'); // untouched, not rewritten, not deleted
    (storage as any).database.prepare('DELETE FROM hub_outbox').run(); // leave the table as we found it
  });

  it('rewrites queued outbox rows from the pending sentinel to the real org', async () => {
    queue('');            // pending-org sentinel (queued pre-login)
    queue('');
    queue('other');       // a different org must be left untouched

    const res = await request(app).post(ROUTE)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ from: '', to: 'acme' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, rewritten: 2 });

    const orgs = (storage as any).hubOutboxPeek(10).map((r: any) => JSON.parse(r.payload).orgId).sort();
    expect(orgs).toEqual(['acme', 'acme', 'other']);
  });
});
