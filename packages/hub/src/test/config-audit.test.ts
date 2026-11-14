/**
 * STORY a89af514 (task 1/3) — the hub's config audit log: storage and reading.
 *
 * One place that answers "who changed this setting, when, from what to what".
 * Rows are append-only and kept forever (the user's call, 2026-10-04); a
 * secret never appears in one - it reads "[secret]", or "[secret: changed]"
 * when it moved. Admins read it newest first, filtered by actor, area and
 * date, and can export the filtered view as CSV.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { recordAudit, listAudit } from '../services/configAudit';
import { loginAs } from './helpers/loginAs';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-audit-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); };

let server: any;
let ctx: any;
let admin = '';

beforeEach(async () => {
  cleanup();
  const out = await createHubApp({ dbPath: TEST_DB, secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' } as any);
  server = out.app.listen(0);
  ctx = out.ctx;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'viewer@x', 'longenough1', 'viewer');
  admin = await loginAs(server, 'admin@x', 'longenough1');
});
afterEach(async () => { await drainApp(server); await ctx.db.close(); cleanup(); });

const entry = (over: Record<string, unknown> = {}) => ({
  orgId: 'org', actor: { userId: 'u-1', email: 'admin@x' }, source: 'board' as const, ip: '10.0.0.1',
  area: 'flows', action: 'flow.update', target: 'flow f-1', before: { name: 'A' }, after: { name: 'B' }, ...over,
});
const get = (q = '') => supertest(server).get(`/v1/admin/audit${q}`).set('Cookie', admin);

describe('reading the audit log', () => {
  it('lists what was recorded, newest first, with who, when, where from and what changed', async () => {
    await recordAudit(ctx.db, entry({ at: '2026-10-01T10:00:00.000Z', action: 'flow.create', before: null, after: { name: 'A' } }));
    await recordAudit(ctx.db, entry({ at: '2026-10-02T10:00:00.000Z' }));
    const r = await get();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows.map((x: any) => x.action)).toEqual(['flow.update', 'flow.create']);
    expect(r.body.rows[0]).toMatchObject({
      at: '2026-10-02T10:00:00.000Z', actorEmail: 'admin@x', source: 'board', ip: '10.0.0.1',
      area: 'flows', target: 'flow f-1', before: { name: 'A' }, after: { name: 'B' },
    });
    expect(r.body.rows[1].before).toBeNull();
  });

  it('is for admins only', async () => {
    const viewer = await loginAs(server, 'viewer@x', 'longenough1');
    expect((await supertest(server).get('/v1/admin/audit').set('Cookie', viewer)).status).toBe(403);
    expect((await supertest(server).get('/v1/admin/audit')).status).toBe(401);
    expect((await supertest(server).get('/v1/admin/audit.csv').set('Cookie', viewer)).status).toBe(403);
  });

  it("shows only this org's rows", async () => {
    await recordAudit(ctx.db, entry({ orgId: 'another-org', action: 'theirs' }));
    await recordAudit(ctx.db, entry({ action: 'ours' }));
    expect((await get()).body.rows.map((x: any) => x.action)).toEqual(['ours']);
  });

  it('filters by area, by actor and by date', async () => {
    await recordAudit(ctx.db, entry({ at: '2026-09-01T00:00:00.000Z', area: 'sign-in', action: 'old' }));
    await recordAudit(ctx.db, entry({ at: '2026-10-01T00:00:00.000Z', area: 'flows', action: 'mine', actor: { userId: 'u-2', email: 'ana@x' } }));
    await recordAudit(ctx.db, entry({ at: '2026-10-02T00:00:00.000Z', area: 'flows', action: 'theirs' }));
    expect((await get('?area=flows')).body.rows.map((x: any) => x.action)).toEqual(['theirs', 'mine']);
    expect((await get('?actor=ana')).body.rows.map((x: any) => x.action)).toEqual(['mine']);
    expect((await get('?from=2026-09-15&to=2026-10-01')).body.rows.map((x: any) => x.action)).toEqual(['mine']);
  });

  it('pages, newest first, with a cursor that never repeats or skips a row', async () => {
    for (let i = 0; i < 5; i++) await recordAudit(ctx.db, entry({ at: '2026-10-01T00:00:00.000Z', action: `a${i}` }));
    const seen: string[] = [];
    let next: string | undefined;
    do {
      const r = await get(`?limit=2${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      expect(r.body.rows.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.rows.map((x: any) => x.action));
      next = r.body.next ?? undefined;
    } while (next);
    expect(seen.sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
  });

  it('refuses a malformed filter instead of guessing', async () => {
    expect((await get('?from=yesterday')).status).toBe(400);
    expect((await get('?limit=0')).status).toBe(400);
  });
});

describe('secrets never reach the log', () => {
  it('keeps no secret value, and says when one changed', async () => {
    await recordAudit(ctx.db, entry({
      area: 'sign-in', action: 'auth-config.update',
      before: { passwordEnabled: true, google: { clientId: 'id-1', clientSecret: 'old-shh' }, apiToken: 'tok-1' },
      after: { passwordEnabled: false, google: { clientId: 'id-1', clientSecret: 'new-shh' }, apiToken: 'tok-1' },
    }));
    const raw = JSON.stringify(await ctx.db.all('SELECT * FROM config_audit', []));
    for (const s of ['old-shh', 'new-shh', 'tok-1']) expect(raw).not.toContain(s);
    const row = (await get()).body.rows[0];
    expect(row.before.google).toEqual({ clientId: 'id-1', clientSecret: '[secret]' });
    expect(row.after.google).toEqual({ clientId: 'id-1', clientSecret: '[secret: changed]' });
    expect(row.after.apiToken).toBe('[secret]');
    expect(row.after.passwordEnabled).toBe(false);
  });
});

describe('the log is append-only', () => {
  it('has no route that edits or deletes a row', async () => {
    await recordAudit(ctx.db, entry());
    const id = (await get()).body.rows[0].id;
    for (const method of ['put', 'patch', 'delete'] as const) {
      const r = await (supertest(server) as any)[method](`/v1/admin/audit/${id}`).set('Cookie', admin).send({});
      expect([404, 405]).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
    expect((await (supertest(server) as any).delete('/v1/admin/audit').set('Cookie', admin)).status).not.toBe(200);
    expect((await get()).body.rows).toHaveLength(1);
  });
});

describe('CSV export of the filtered view', () => {
  it('downloads the rows the filters select, one line each, as an attachment', async () => {
    await recordAudit(ctx.db, entry({ area: 'sign-in', action: 'not-this' }));
    await recordAudit(ctx.db, entry({ action: 'flow.update', target: 'flow "Main", v2' }));
    const r = await supertest(server).get('/v1/admin/audit.csv?area=flows').set('Cookie', admin);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="?hub-audit[^"]*\.csv"?/);
    const lines = r.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('at,actor,source,ip,area,action,target,before,after,link');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"flow ""Main"", v2"');
    expect(r.text).not.toContain('not-this');
  });

  it('neutralises a value a spreadsheet would run as a formula', async () => {
    await recordAudit(ctx.db, entry({ target: '=HYPERLINK("http://evil")' }));
    const r = await supertest(server).get('/v1/admin/audit.csv').set('Cookie', admin);
    expect(r.text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(r.text).toContain("'=HYPERLINK");
  });
});

describe('listAudit', () => {
  it('caps a page at 200 rows whatever is asked', async () => {
    expect((await listAudit(ctx.db, 'org', { limit: 10_000 })).rows).toEqual([]);
    const r = await get('?limit=10000');
    expect(r.status).toBe(200);
  });
});
