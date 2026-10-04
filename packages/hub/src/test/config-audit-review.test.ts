/**
 * BUG 91d2941d — the CGLAB-494 reviews of the config audit log.
 *
 *  - A malformed %-escape on an audited route crashed the hub (an async
 *    middleware's URIError, unhandled under Express 4).
 *  - Express routes /V1/ADMIN/... to the same handler; the audit's own
 *    case-sensitive matcher skipped it, so a change went unrecorded.
 *  - Rows were written on 'finish' - after the reply, and never for a client
 *    that hung up - so a committed change could leave no row.
 *  - password_enabled 1 -> 0 read "[secret]" -> "[secret: changed]".
 *  - Snapshots used the org id captured at boot, so after an org rename every
 *    update looked like a creation.
 *  - Many areas recorded no "before"; a password reset recorded no change.
 *  - The parent hub's own changes on a child (revocation, identity policy,
 *    upgrade dispatch) left no row, and a dispatch that changed nothing still
 *    wrote one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp, hubErrorHandler } from '../server';
import { createPasswordUser } from '../auth/password';
import { listAudit, recordAudit } from '../services/configAudit';
import { installDispatchedFlow, federationTick } from '../services/federation/federationSync';
import { writeParentBinding } from '../services/federation/parentBinding';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-audit-review-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

let server: any;
let ctx: any;
let admin = '';

async function boot(extra: Record<string, unknown> = {}) {
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org', ...extra } as any);
  server = out.app.listen(0);
  ctx = out.ctx;
}
beforeEach(async () => {
  cleanup();
  await boot();
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
  admin = await loginAs(server, 'admin@x', 'longenough1');
});
afterEach(async () => { await drainApp(server); await ctx.db.close(); cleanup(); });

const definition = (name: string, label = 'Build') => ({
  name,
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'build', label, order: 1, role: 'coding' },
    { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
  ],
});
/** Rows as they stand the moment a reply arrives - no waiting: a row must be written before the reply. */
const now = async (org = 'org', area?: string) => (await listAudit(ctx.db, org, { area, limit: 200 })).rows;

describe('the audit layer cannot be used against the hub', () => {
  it('a malformed escape on an audited route is answered, and the hub stays up', async () => {
    const r = await supertest(server).delete('/v1/admin/users/%E0%A4%A');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    const signedIn = await supertest(server).delete('/v1/admin/flows/%E0%A4%A').set('Cookie', admin);
    expect(signedIn.status).toBeLessThan(500);
    expect((await supertest(server).get('/healthz')).status).toBe(200);
  });
});

describe('every served change is recorded, and before the reply', () => {
  it('records a change made through a case-varied path', async () => {
    const r = await supertest(server).put('/V1/ADMIN/auth-config').set('Cookie', admin).send({ passwordEnabled: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await now()).map(x => x.action)).toContain('auth-config.update');
  });

  it('has the row in place when the reply arrives', async () => {
    const created = await supertest(server).post('/v1/admin/flows').set('Cookie', admin).send({ definition: definition('Main') });
    expect(created.status).toBeLessThan(300);
    expect((await now('org', 'flows')).map(x => x.action)).toEqual(['flow.create']);
  });

  it('writes nothing for a request a guard refused, and reads nothing for it either', async () => {
    const viewer = await loginAs(server, 'viewer@x', 'longenough1');
    expect((await supertest(server).put('/v1/admin/auth-config').set('Cookie', viewer).send({ passwordEnabled: false })).status).toBe(403);
    expect((await supertest(server).put('/v1/admin/auth-config').send({ passwordEnabled: false })).status).toBe(401);
    expect(await now()).toEqual([]);
  });
});

describe('what a row says changed', () => {
  it('shows password sign-in switched off as 1 -> 0, not as a secret', async () => {
    await supertest(server).put('/v1/admin/auth-config').set('Cookie', admin).send({
      passwordEnabled: false, googleEnabled: true, google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh-1' },
    });
    const [row] = await now('org', 'sign-in');
    expect((row.before as any).password_enabled).toBe(1);
    expect((row.after as any).password_enabled).toBe(0);
    expect(JSON.stringify(row)).not.toContain('shh-1');
  });

  it('says a password reset changed the password, without the hash', async () => {
    const viewer = await ctx.db.get('SELECT id, password_hash FROM users WHERE email = ?', ['viewer@x']);
    expect((await supertest(server).put(`/v1/admin/users/${viewer.id}`).set('Cookie', admin).send({ password: 'a-new-password-9' })).status).toBe(200);
    const [row] = await now('org', 'users');
    expect((row.after as any).password_hash).toBe('[secret: changed]');
    expect(JSON.stringify(row)).not.toContain(viewer.password_hash);
  });

  it('records the before of a model mapping removed, and a hidden person added and shown again', async () => {
    await supertest(server).post('/v1/admin/models/mappings').set('Cookie', admin).send({ aliasModel: 'opus-x', canonicalModel: 'claude-opus-5-5' });
    await supertest(server).delete('/v1/admin/models/mappings/opus-x').set('Cookie', admin);
    const [unmap, map] = await now('org', 'models');
    expect(map.after).toMatchObject({ alias_model: 'opus-x', canonical_model: 'claude-opus-5-5' });
    expect(unmap.before).toMatchObject({ alias_model: 'opus-x' });
    expect(unmap.after).toBeNull();

    await supertest(server).post('/v1/admin/hidden-users').set('Cookie', admin).send({ userKey: 'bot@x' });
    await supertest(server).delete('/v1/admin/hidden-users/bot%40x').set('Cookie', admin);
    const [unhide, hide] = await now('org', 'people');
    expect(hide.before).toBeNull();
    expect(hide.after).toMatchObject({ user_key: 'bot@x' });
    expect(unhide.before).toMatchObject({ user_key: 'bot@x' });
  });

  it("after an org rename, an update still shows its before (the audit reads the org as it is now)", async () => {
    const created = await supertest(server).post('/v1/admin/flows').set('Cookie', admin).send({ definition: definition('Main') });
    const rename = await supertest(server).post('/v1/admin/orgs/rename').set('Cookie', admin).send({ from: 'org', to: 'acme' });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
    const fresh = rename.headers['set-cookie']?.[0] ?? (await loginAs(server, 'admin@x', 'longenough1'));
    expect((await supertest(server).put(`/v1/admin/flows/${created.body.id}`).set('Cookie', fresh).send({ definition: definition('Main', 'Implement') })).status).toBe(200);
    const upd = (await now('acme', 'flows')).find(x => x.action === 'flow.update')!;
    expect(JSON.stringify(upd.before)).toContain('"Build"');
  });
});

describe("the parent hub's changes on this hub", () => {
  it('a dispatch that changes nothing writes no row; one that reclaims a local edit shows what it replaced', async () => {
    const d = { dispatchId: 'd-1', flowVersion: 2, flow: { id: 'pf-1', name: 'Parent flow', version: 2, definition: definition('Parent flow') } };
    expect(await installDispatchedFlow(ctx.db, 'org', d as any)).toBe(true);
    expect(await installDispatchedFlow(ctx.db, 'org', d as any)).toBe(true);
    expect((await now('org', 'federation')).map(x => x.action)).toEqual(['flow.dispatch-install']);
    await ctx.db.run("UPDATE flows SET source = 'hub', name = 'Edited here' WHERE id = 'pf-1'");
    await installDispatchedFlow(ctx.db, 'org', d as any);
    const [reclaim] = await now('org', 'federation');
    expect(reclaim.before).toMatchObject({ source: 'hub', name: 'Edited here' });
    expect(reclaim.after).toMatchObject({ source: 'parent' });
  });
});

describe("the parent hub's changes, seen by the federation worker", () => {
  const SEC = 'a'.repeat(64);
  const bind = () => writeParentBinding(ctx.db, SEC, { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' } as any);
  const quiet = { directives: async () => null, deliver: async () => ({}) };

  it('records the parent revoking this hub, even with no parent flows to release', async () => {
    await bind();
    const r = await federationTick({ db: ctx.db, secretKey: SEC, orgId: 'org', transport: { ...quiet, ping: async () => { throw Object.assign(new Error('gone'), { response: { status: 401 } }); } } } as any);
    expect(r.revoked).toBe(true);
    expect((await now('org', 'federation')).map(x => x.action)).toContain('parent.revoked');
  });

  it('records the identity policy the parent set, before -> after', async () => {
    await bind();
    await federationTick({ db: ctx.db, secretKey: SEC, orgId: 'org', transport: { ...quiet, ping: async () => ({ ok: true, identityPolicy: 'pseudonymize' }) } } as any);
    const row = (await now('org', 'federation')).find(x => x.action === 'identity-policy.parent-update');
    expect(row, JSON.stringify(await now())).toBeTruthy();
    expect(row!.after).toMatchObject({ identityPolicy: 'pseudonymize' });
    expect(JSON.stringify(row)).not.toContain('f'.repeat(64));
  });
});

describe('reading the log', () => {
  it('caps a page at 200 rows', async () => {
    for (let i = 0; i < 205; i++) await recordAudit(ctx.db, { orgId: 'org', actor: null, source: 'system', ip: null, area: 'flows', action: `a${i}`, target: null, before: null, after: null, at: '2026-10-01T00:00:00.000Z' });
    const r = await supertest(server).get('/v1/admin/audit?limit=10000').set('Cookie', admin);
    expect(r.body.rows).toHaveLength(200);
    expect(r.body.next).toBeTruthy();
  });

  it('says in the CSV when the export stopped at its cap', async () => {
    await drainApp(server); await ctx.db.close();
    await boot({ auditCsvMaxRows: 3 });
    admin = await loginAs(server, 'admin@x', 'longenough1');
    for (let i = 0; i < 5; i++) await recordAudit(ctx.db, { orgId: 'org', actor: null, source: 'system', ip: null, area: 'flows', action: `a${i}`, target: null, before: null, after: null });
    const r = await supertest(server).get('/v1/admin/audit.csv').set('Cookie', admin);
    const lines = r.text.trim().split(/\r?\n/);
    expect(lines.length).toBe(1 + 3 + 1);
    expect(lines[lines.length - 1]).toMatch(/truncated/i);
  });
});

describe('review round 2 (BUG 915f76ed)', () => {
  it('ends a CSV export that fails part-way instead of leaving the download hanging', async () => {
    for (let i = 0; i < 5; i++) await recordAudit(ctx.db, { orgId: 'org', actor: null, source: 'system', ip: null, area: 'flows', action: `a${i}`, target: null, before: null, after: null });
    await drainApp(server); await ctx.db.close();
    await boot({ auditCsvMaxRows: 100 });
    admin = await loginAs(server, 'admin@x', 'longenough1');
    const all = ctx.db.all.bind(ctx.db);
    let calls = 0;
    ctx.db.all = async (sql: string, p: unknown[]) => {
      // The header line is already on the wire before the first page is read: a failure there is mid-stream.
      if (/FROM config_audit/.test(sql) && ++calls >= 1) throw new Error('db went away');
      return all(sql, p);
    };
    const started = Date.now();
    const r = await supertest(server).get('/v1/admin/audit.csv?limit=2').set('Cookie', admin).timeout(5000).catch((e: any) => e);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(String(r?.code ?? r?.message ?? r?.text ?? '')).not.toMatch(/ECONNABORTED|Timeout/i);
  });

  it("files the federation worker's rows under the org as it is now, after a rename", async () => {
    await drainApp(server); await ctx.db.close();
    let revoke = false;
    const transport = { ping: async () => { if (revoke) throw Object.assign(new Error('gone'), { response: { status: 401 } }); return { ok: true }; }, directives: async () => null, deliver: async () => ({}) };
    await boot({ federationTransport: transport, federationIntervalMs: 40 });
    admin = await loginAs(server, 'admin@x', 'longenough1');
    expect((await supertest(server).post('/v1/admin/orgs/rename').set('Cookie', admin).send({ from: 'org', to: 'acme' })).status).toBe(200);
    await writeParentBinding(ctx.db, 'a'.repeat(64), { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' } as any);
    revoke = true;
    const deadline = Date.now() + 3000;
    let rows: any[] = [];
    while (Date.now() < deadline && !rows.length) {
      rows = (await listAudit(ctx.db, 'acme', { area: 'federation' })).rows.filter(x => x.action === 'parent.revoked');
      if (!rows.length) await new Promise(res => setTimeout(res, 40));
    }
    expect(rows).toHaveLength(1);
  });

  it("keeps the flow's definition on a dispatch row, before and after", async () => {
    const d = { dispatchId: 'd-1', flowVersion: 2, flow: { id: 'pf-9', name: 'Parent flow', version: 2, definition: definition('Parent flow') } };
    await installDispatchedFlow(ctx.db, 'org', d as any);
    await installDispatchedFlow(ctx.db, 'org', { ...d, flowVersion: 3, flow: { ...d.flow, version: 3, definition: definition('Parent flow', 'Implement') } } as any);
    const [v3] = await now('org', 'federation');
    expect(JSON.stringify(v3.before)).toContain('"Build"');
    expect(JSON.stringify(v3.after)).toContain('"Implement"');
  });

  it('records the key a case-varied preview revoked, live before and revoked after', async () => {
    const issued = await supertest(server).post('/v1/admin/api-keys').set('Cookie', admin).send({ label: 'ci' });
    expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
    const hash = (await ctx.db.get("SELECT token_hash FROM api_keys WHERE label = 'ci'")).token_hash as string;
    const r = await supertest(server).delete(`/v1/admin/api-keys/${hash.slice(0, 12).toUpperCase()}`).set('Cookie', admin);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const row = (await now('org', 'api-keys')).find(x => x.action === 'api-key.revoke')!;
    expect(row.before).toMatchObject({ label: 'ci', revoked_at: null });
    expect((row.after as any)?.revoked_at).toBeTruthy();
  });
});

describe('an error after an audited reply (BUG 915f76ed)', () => {
  it('does not replace a reply whose audit row is still being written', () => {
    const res: any = { headersSent: false, locals: { auditReplyPending: true }, status: vi.fn(() => res), json: vi.fn(() => res) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    hubErrorHandler(new Error('after the reply'), {} as any, res, (() => {}) as any);
    log.mockRestore();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
