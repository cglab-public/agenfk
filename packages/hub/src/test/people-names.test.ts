import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

/**
 * GET /v1/people/names — the display name behind each user_key, so the
 * dashboards can show "Carol Diaz" instead of carol@acme.com in monospace.
 * The key is derived exactly as ingest derives it (email, or a namespaced OS
 * user, then aliases), and the newest installation's git name wins.
 */
let server: any;
const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-people-names-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const event = (id: string, installationId: string, occurredAt: string, actor: Record<string, string | undefined>) => ({
  eventId: id, installationId, orgId: 'org', occurredAt, actor,
  type: 'item.created', projectId: 'p1', itemId: 'i1', payload: {},
});

describe('GET /v1/people/names', () => {
  let ctx: any;
  let cookie: string;
  let send: (token: string, events: unknown[]) => Promise<unknown>;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
    if (server) await new Promise<void>(r => server.close(() => r()));
    server = out.app.listen(0);
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(server).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
    send = (token, events) => supertest(server).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
  });

  afterEach(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()));
    server = undefined;
    await ctx?.db?.close?.();
    cleanup();
  });

  const names = async () => (await supertest(server).get('/v1/people/names').set('Cookie', cookie).expect(200)).body.names;

  it("names a person by their installation's git name, keyed like their events", async () => {
    const token = await issueApiKey(ctx.db, 'org', 't');
    await send(token, [event('e1', 'inst-1', '2026-09-01T10:00:00Z', { osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'Carol@Acme.com' })]);
    expect(await names()).toEqual({ 'carol@acme.com': 'Carol Diaz' });
  });

  it('prefers the name from the most recently seen installation', async () => {
    const token = await issueApiKey(ctx.db, 'org', 't');
    await send(token, [event('e1', 'inst-old', '2026-08-01T10:00:00Z', { osUser: 'carol', gitName: 'C. Diaz', gitEmail: 'carol@acme.com' })]);
    await send(token, [event('e2', 'inst-new', '2026-09-01T10:00:00Z', { osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@acme.com' })]);
    // last_seen is the receive time, so make the order explicit.
    await ctx.db.run("UPDATE installations SET last_seen = '2026-08-01T00:00:00Z' WHERE id = 'inst-old'");
    await ctx.db.run("UPDATE installations SET last_seen = '2026-09-01T00:00:00Z' WHERE id = 'inst-new'");
    expect((await names())['carol@acme.com']).toBe('Carol Diaz');
  });

  it('names a machine without a git email under its namespaced OS-user key', async () => {
    const token = await issueApiKey(ctx.db, 'org', 't');
    await send(token, [event('e1', 'inst-abcdef12', '2026-09-01T10:00:00Z', { osUser: 'dave', gitName: 'Dave Ng' })]);
    const [[key, name]] = Object.entries(await names());
    expect(name).toBe('Dave Ng');
    // The same key the events carry, so the UI can look it up.
    const row = await ctx.db.get('SELECT user_key FROM events WHERE event_id = ?', ['e1']);
    expect(key).toBe(row.user_key);
  });

  it('follows a merge: an aliased email names its canonical person', async () => {
    const token = await issueApiKey(ctx.db, 'org', 't');
    await send(token, [event('e1', 'inst-2', '2026-09-01T10:00:00Z', { osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@home.dev' })]);
    await ctx.db.run(
      'INSERT INTO user_key_aliases (org_id, alias_key, canonical_key, merge_id) VALUES (?, ?, ?, ?)',
      ['org', 'carol@home.dev', 'carol@acme.com', 'm1'],
    );
    expect(await names()).toEqual({ 'carol@acme.com': 'Carol Diaz' });
  });

  it('leaves out a person with no git name', async () => {
    const token = await issueApiKey(ctx.db, 'org', 't');
    await send(token, [event('e1', 'inst-1', '2026-09-01T10:00:00Z', { osUser: 'erin', gitName: '  ', gitEmail: 'erin@acme.com' })]);
    expect(await names()).toEqual({});
  });

  it('leaves out a hidden person', async () => {
    const token = await issueApiKey(ctx.db, 'org', 't');
    await send(token, [event('e1', 'inst-1', '2026-09-01T10:00:00Z', { osUser: 'frank', gitName: 'Frank Ho', gitEmail: 'frank@acme.com' })]);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'frank@acme.com']);
    expect(await names()).toEqual({});
  });

  it("never returns another org's people", async () => {
    const other = await issueApiKey(ctx.db, 'org-b', 't');
    await send(other, [{ ...event('e1', 'inst-9', '2026-09-01T10:00:00Z', { osUser: 'gina', gitName: 'Gina Lu', gitEmail: 'gina@other.com' }), orgId: 'org-b' }]);
    expect(await names()).toEqual({});
  });

  it('requires a session', async () => {
    await supertest(server).get('/v1/people/names').expect(401);
  });
});
