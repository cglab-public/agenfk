// A federation parent names a child hub's developers (BUG 4159631f).
//
// The parent has no installation for them: their events arrive through
// POST /v1/federation/deliver. The name is recorded THERE, from each row's
// actor, and only when the row's identity policy is `keep`; a pseudonymizing
// group never reveals a name, whatever the row carries. These go through the
// real deliver route, and the pseudonymized rows are built by the child's own
// redactIdentity, so the privacy claim is pinned on the real shapes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { redactIdentity } from '../services/federation/forwarding';
import { migrateChildPeopleNames, CHILD_PEOPLE_MIGRATION } from '../services/migrateChildPeopleNames';

const DB = path.join(os.tmpdir(), `agenfk-hub-fed-names-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

const childEvent = (eventId: string, occurredAt: string, actor: Record<string, string | null> | null, userKey = 'hana@child.com') => ({
  eventId, orgId: 'org', installationId: 'child-inst', occurredAt, type: 'item.closed',
  itemId: 'i1', payload: {}, userKey, actor,
});
const row = (childHubId: string, event: Record<string, unknown>, identityPolicy: 'keep' | 'pseudonymize' = 'keep') => ({
  id: `outbox-${event.eventId}`, kind: 'event', payload: { childHubId, identityPolicy, event },
});

describe('a federation parent names child-hub developers', () => {
  let server: any; let ctx: any; let cookie: string; let child: { token: string; childHubId: string };

  const deliver = async (rows: unknown[]) => {
    const r = await supertest(server).post('/v1/federation/deliver').set('Authorization', `Bearer ${child.token}`).send({ rows });
    expect(r.status).toBe(200);
    return r.body;
  };
  const names = async () => (await supertest(server).get('/v1/people/names').set('Cookie', cookie).expect(200)).body.names;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    ctx = out.ctx;
    server = out.app.listen(0);
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(server).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    const inv = await supertest(server).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(server).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name: 'alpha' } });
    expect(enr.status).toBe(200);
    child = enr.body;
  });
  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    await ctx?.db?.close?.();
    cleanup();
  });

  it('names a developer a keep-policy child forwarded', async () => {
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }))]);
    expect(await names()).toEqual({ 'hana@child.com': 'Hana Ito' });
  });

  it('keeps the name when a later event comes from a machine without one', async () => {
    await deliver([
      row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' })),
      row(child.childHubId, childEvent('e2', '2026-09-02T10:00:00.000Z', { osUser: 'hana', gitName: null, gitEmail: 'hana@child.com' })),
    ]);
    expect((await names())['hana@child.com']).toBe('Hana Ito');
  });

  it('takes the newest name, even when an older event is delivered late', async () => {
    await deliver([row(child.childHubId, childEvent('e2', '2026-09-02T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }))]);
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'H. Ito', gitEmail: 'hana@child.com' }))]);
    expect((await names())['hana@child.com']).toBe('Hana Ito');
  });

  it('never names anyone a pseudonymizing child forwarded', async () => {
    const raw = childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' });
    await deliver([row(child.childHubId, redactIdentity(raw, child.childHubId, SECRET), 'pseudonymize')]);
    expect(await names()).toEqual({});
  });

  it('never names from a row that claims pseudonymize but still carries an actor', async () => {
    // A buggy or older child: the policy on the row is the group's word.
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }), 'pseudonymize')]);
    expect(await names()).toEqual({});
  });

  it("follows the parent's policy over a row's label: no names once the parent pseudonymizes", async () => {
    // The child queued these as `keep` before it heard of the switch.
    await ctx.db.run('UPDATE child_hubs SET identity_policy = ? WHERE id = ?', ['pseudonymize', child.childHubId]);
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }))]);
    expect(await names()).toEqual({});
  });

  it('never names a hidden person', async () => {
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'hana@child.com']);
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }))]);
    expect(await names()).toEqual({});
  });

  it('stops naming someone hidden after their name was recorded', async () => {
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }))]);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'hana@child.com']);
    expect(await names()).toEqual({});
  });

  it("prefers this hub's own installation name", async () => {
    await ctx.db.run(
      "INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email) VALUES ('local', 'org', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 'hana', 'Hana Local', 'hana@child.com')",
    );
    await deliver([row(child.childHubId, childEvent('e1', '2026-09-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' }))]);
    expect((await names())['hana@child.com']).toBe('Hana Local');
  });

  it('backfills names from events forwarded before this release, once', async () => {
    const legacy = (id: string, at: string, actor: unknown) => ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload, child_hub_id)
       VALUES (?, 'org', 'child-inst', 'hana@child.com', ?, ?, 'item.closed', ?, ?)`,
      [id, at, at, JSON.stringify({ actor }), child.childHubId],
    );
    await legacy('old1', '2026-08-01T10:00:00.000Z', { osUser: 'hana', gitName: 'Hana Ito', gitEmail: 'hana@child.com' });
    await legacy('old2', '2026-08-02T10:00:00.000Z', null);
    // Boot already ran it against an empty table; a hub upgrading with history
    // has never run it.
    await ctx.db.run('DELETE FROM system_state WHERE key = ?', [CHILD_PEOPLE_MIGRATION]);
    // Never a pseudonym, even one that arrived with a name.
    await ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload, child_hub_id)
       VALUES ('old3', 'org', 'child-inst', 'anon:0123456789abcdef', ?, ?, 'item.closed', ?, ?)`,
      ['2026-08-03T10:00:00.000Z', '2026-08-03T10:00:00.000Z', JSON.stringify({ actor: { gitName: 'Leaked' } }), child.childHubId],
    );
    const first = await migrateChildPeopleNames(ctx.db);
    expect(first).toEqual({ skipped: false, named: 1 });
    expect(await names()).toEqual({ 'hana@child.com': 'Hana Ito' });
    expect(await migrateChildPeopleNames(ctx.db)).toEqual({ skipped: true, named: 0 });
  });

  it("backfills nothing for a child the parent now pseudonymizes", async () => {
    await ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, payload, child_hub_id)
       VALUES ('old1', 'org', 'child-inst', 'hana@child.com', ?, ?, 'item.closed', ?, ?)`,
      ['2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z', JSON.stringify({ actor: { gitName: 'Hana Ito' } }), child.childHubId],
    );
    await ctx.db.run('UPDATE child_hubs SET identity_policy = ? WHERE id = ?', ['pseudonymize', child.childHubId]);
    await ctx.db.run('DELETE FROM system_state WHERE key = ?', [CHILD_PEOPLE_MIGRATION]);
    expect(await migrateChildPeopleNames(ctx.db)).toEqual({ skipped: false, named: 0 });
    expect(await names()).toEqual({});
  });
});
