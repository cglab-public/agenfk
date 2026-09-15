// A flow the parent sent is read-only on the child — and unlocks on detach
// (CGLAB-182, task 3).
//
// Two halves, and they are different kinds of thing:
//  - the CONTROL is server-side, in the flows routes. A child admin cannot
//    rename, re-define or delete a flow their parent owns, whatever the UI
//    does or whichever client is talking to the API.
//  - the UNLOCK is the promise that detaching costs a team nothing. The flows
//    STAY and become ordinary local flows (user-confirmed), so nothing anybody
//    is working under disappears, and the child regains control of its hub.
//
// The unlock fires on BOTH paths out of the group: the parent-side detach,
// which this hub discovers as a 401 and records by revoking the binding, and
// the child-side leave once it has been released. A hub whose parent detached
// it but whose admin has not yet clicked Leave would otherwise be left holding
// flows that nobody anywhere can edit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';
import { openDb } from '../db';
import type { HubDb } from '../db/types';
import { writeParentBinding, readParentBinding } from '../services/federation/parentBinding';
import { federationTick } from '../services/federation/federationSync';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flow-ro-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const def = (name: string) => ({
  name,
  description: '',
  steps: [
    { id: 's0', name: 'TODO', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
  ],
});

describe('a parent-origin flow is read-only on the child', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  // A flow the parent dispatched, and a flow this hub authored itself that
  // happens to share its NAME — the clash case the user chose to allow. The
  // local one must stay fully editable throughout; if the guard keys on the
  // name rather than the origin it takes this one down with it.
  const seed = async () => {
    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, ?, 'parent', 3, 1)`,
      ['flow-from-parent', 'org', 'Group TDD', 'the org standard', JSON.stringify(def('Group TDD'))],
    );
    await ctx.db.run(
      `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, ?, 'hub', 1, 1)`,
      ['flow-local', 'org', 'Group TDD', 'ours, same name', JSON.stringify(def('Group TDD'))],
    );
  };

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login')
      .send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    await seed();
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  const row = (id: string) => ctx.db.get<any>('SELECT * FROM flows WHERE id = ?', [id]);

  it('refuses to re-define it, and says why', async () => {
    const r = await supertest(app).put('/v1/admin/flows/flow-from-parent')
      .set('Cookie', cookie).send({ definition: def('Group TDD (edited)') });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/parent hub/i);
    // Refused means UNCHANGED — not refused-after-writing.
    const after = await row('flow-from-parent');
    expect(after.name).toBe('Group TDD');
    expect(after.version).toBe(3);
    expect(JSON.parse(after.definition_json).name).toBe('Group TDD');
  });

  it('refuses to rename it', async () => {
    const r = await supertest(app).put('/v1/admin/flows/flow-from-parent')
      .set('Cookie', cookie).send({ definition: def('Renamed By The Child') });
    expect(r.status).toBe(409);
    expect((await row('flow-from-parent')).name).toBe('Group TDD');
  });

  it('refuses to delete it', async () => {
    const r = await supertest(app).delete('/v1/admin/flows/flow-from-parent').set('Cookie', cookie);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/parent hub/i);
    expect(await row('flow-from-parent')).toBeTruthy();
  });

  it('still lets the child choose whether to OFFER it — the definition is the parent\'s, the availability is not', async () => {
    const r = await supertest(app).put('/v1/admin/flows/flow-from-parent/availability')
      .set('Cookie', cookie).send({ available: false });
    expect(r.status).toBe(200);
    expect(!!(await row('flow-from-parent')).org_available).toBe(false);
  });

  it('leaves the child\'s own same-named flow fully editable', async () => {
    const edit = await supertest(app).put('/v1/admin/flows/flow-local')
      .set('Cookie', cookie).send({ definition: def('Ours, Renamed') });
    expect(edit.status).toBe(200);
    expect((await row('flow-local')).name).toBe('Ours, Renamed');

    const del = await supertest(app).delete('/v1/admin/flows/flow-local').set('Cookie', cookie);
    expect(del.status).toBe(200);
    expect(await row('flow-local')).toBeFalsy();
  });

  it('tells the UI where the flow came from, so a shared name is not ambiguous', async () => {
    const r = await supertest(app).get('/v1/admin/flows').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.map((f: any) => [f.id, f]));
    expect(byId['flow-from-parent'].source).toBe('parent');
    expect(byId['flow-local'].source).toBe('hub');
  });

  it('unlocks them when the child leaves, and the flows survive', async () => {
    // Released by the parent — the only state from which a child may leave.
    await writeParentBinding(ctx.db, SECRET, {
      parentUrl: 'https://parent.example.com',
      token: 'fed_' + 'f'.repeat(64),
      childHubId: 'ch-1',
      state: 'revoked',
    });

    const left = await supertest(app).delete('/v1/admin/federation').set('Cookie', cookie);
    expect(left.status).toBe(200);

    // Still here, and now ordinary.
    const after = await row('flow-from-parent');
    expect(after).toBeTruthy();
    expect(after.source).toBe('hub');
    expect(after.name).toBe('Group TDD');
    expect(JSON.parse(after.definition_json).steps).toHaveLength(2);

    // And editable, which is the whole point of unlocking.
    const edit = await supertest(app).put('/v1/admin/flows/flow-from-parent')
      .set('Cookie', cookie).send({ definition: def('Now Ours') });
    expect(edit.status).toBe(200);
    expect((await row('flow-from-parent')).name).toBe('Now Ours');
  });

  it('a hub that never had a parent is not disturbed by the leave path', async () => {
    const left = await supertest(app).delete('/v1/admin/federation').set('Cookie', cookie);
    expect(left.status).toBe(200);
    expect((await row('flow-local')).source).toBe('hub');
  });
});

// The other way out of the group: the parent detaches, and this hub finds out
// when its next tick is refused. There is no admin action in this path at all,
// so the unlock cannot live only in the leave route.
describe('the parent detaching also unlocks the flows it sent', () => {
  let db: HubDb;
  const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

  const refusingTransport = {
    async ping() {
      const err: any = new Error('Invalid, revoked or detached federation key');
      err.response = { status: 401, data: { error: 'Invalid, revoked or detached federation key' } };
      throw err;
    },
    async directives() { return null; },
    async deliver(rows: any[]) { return { accepted: rows.length }; },
  };

  beforeEach(async () => {
    db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
    await db.run(
      `INSERT INTO flows (id, org_id, name, description, definition_json, source, version, org_available)
       VALUES (?, ?, ?, ?, ?, 'parent', 2, 1)`,
      ['flow-from-parent', 'org', 'Group TDD', null, JSON.stringify(def('Group TDD'))],
    );
  });

  it('flips them back to local when the parent refuses the key', async () => {
    const out = await federationTick({ db, secretKey: SECRET, transport: refusingTransport, orgId: 'org' } as any);
    expect(out.revoked).toBe(true);
    expect((await readParentBinding(db, SECRET))!.state).toBe('revoked');

    const after = await db.get<any>('SELECT * FROM flows WHERE id = ?', ['flow-from-parent']);
    expect(after).toBeTruthy();
    expect(after.source).toBe('hub');
  });

  it('a transport failure that is NOT a revocation leaves them locked', async () => {
    const flaky = {
      async ping() { throw new Error('ECONNREFUSED'); },
      async directives() { return null; },
      async deliver(rows: any[]) { return { accepted: rows.length }; },
    };
    const out = await federationTick({ db, secretKey: SECRET, transport: flaky, orgId: 'org' } as any);
    expect(out.revoked).toBeFalsy();
    expect((await db.get<any>('SELECT source FROM flows WHERE id = ?', ['flow-from-parent'])).source).toBe('parent');
  });
});
