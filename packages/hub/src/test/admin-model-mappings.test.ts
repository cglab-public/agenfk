// Admin model mappings:
//   GET    /v1/admin/models                    — mappings + every model id seen in events
//   POST   /v1/admin/models/mappings           — map an alias to a canonical name
//   DELETE /v1/admin/models/mappings/:alias    — remove a mapping (reverts the dashboards)
//
// The bug these exist for: one model reported as `qwen38-27b` and `qwen3.8:27b`
// appeared as two rows in the PR Overview "By model" table, splitting its PR
// count. Resolution is a read-time overlay, so `events` keeps what was reported.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-model-mappings-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('admin model mappings', () => {
  let app: any;
  let ctx: any;
  let cookie: string;
  let send: (events: any[]) => Promise<any>;

  const pr = (over: any) => ({
    eventId: 'e-' + Math.random().toString(36).slice(2),
    installationId: 'inst-1',
    orgId: 'org',
    occurredAt: '2026-05-03T10:00:00Z',
    actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
    type: 'pr.opened',
    remoteUrl: 'git@github.com:acme/api.git',
    payload: {
      prNumber: over.prNumber,
      repo: 'acme/api',
      model: over.model,
      harness: 'pi',
      sizing: { epic: 0, story: 0, task: 1, bug: 0 },
      sizingShadow: { epic: 0, story: 0, task: 1, bug: 0 },
      leafStory: 0,
    },
  });

  const overview = async (qs = '') =>
    (await supertest(app).get(`/v1/prs/overview${qs}`).set('Cookie', cookie)).body;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
    const token = await issueApiKey(ctx.db, 'org', 'test');
    send = (events: any[]) =>
      supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });

    // The same model under three spellings, plus one genuinely different model.
    await send([
      pr({ prNumber: 1, model: 'qwen3.8:27b' }),
      pr({ prNumber: 2, model: 'qwen38-27b' }),
      pr({ prNumber: 3, model: 'qwen38-27b' }),
      pr({ prNumber: 4, model: 'glm-5.2' }),
    ]);
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('the bug', () => {
    it('splits one model across rows before any mapping exists', async () => {
      const r = await overview();
      expect(r.byModel.map((m: any) => m.model)).toContain('qwen38-27b');
      expect(r.byModel.map((m: any) => m.model)).toContain('qwen3.8:27b');
      expect(r.byModel.find((m: any) => m.model === 'qwen38-27b').prs).toBe(2);
    });
  });

  describe('GET /v1/admin/models', () => {
    it('lists observed model ids with their PR counts, unmapped by default', async () => {
      const r = await supertest(app).get('/v1/admin/models').set('Cookie', cookie);
      expect(r.status).toBe(200);
      expect(r.body.mappings).toEqual([]);
      const q = r.body.observed.find((o: any) => o.model === 'qwen38-27b');
      expect(q).toMatchObject({ prs: 2, canonicalModel: 'qwen38-27b', isMapped: false });
    });

    it('requires admin', async () => {
      const r = await supertest(app).get('/v1/admin/models');
      expect(r.status).toBe(401);
    });
  });

  describe('POST /v1/admin/models/mappings', () => {
    const post = (body: any) =>
      supertest(app).post('/v1/admin/models/mappings').set('Cookie', cookie).send(body);

    it('creates a mapping and records who made it', async () => {
      const r = await post({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
      expect(r.status).toBe(201);
      const list = await supertest(app).get('/v1/admin/models').set('Cookie', cookie);
      expect(list.body.mappings).toHaveLength(1);
      expect(list.body.mappings[0]).toMatchObject({
        aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b', createdByEmail: 'admin@x',
      });
    });

    it('trims surrounding whitespace, which is invisible in a table cell', async () => {
      const r = await post({ aliasModel: '  qwen38-27b  ', canonicalModel: '  qwen3.8:27b ' });
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
    });

    it.each([
      ['missing alias', { canonicalModel: 'qwen3.8:27b' }],
      ['missing canonical', { aliasModel: 'qwen38-27b' }],
      ['empty alias', { aliasModel: '   ', canonicalModel: 'qwen3.8:27b' }],
      ['alias identical to canonical', { aliasModel: 'x', canonicalModel: 'x' }],
      ['non-string alias', { aliasModel: 42, canonicalModel: 'qwen3.8:27b' }],
      ['control characters', { aliasModel: 'qwen\u000038', canonicalModel: 'qwen3.8:27b' }],
      ['overlong id', { aliasModel: 'a'.repeat(201), canonicalModel: 'qwen3.8:27b' }],
    ])('rejects %s', async (_name, body) => {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBeTruthy();
    });

    it('refuses to silently re-point an alias already mapped elsewhere', async () => {
      await post({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
      const r = await post({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen-3.8' });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('qwen3.8:27b');
      // unchanged
      const list = await supertest(app).get('/v1/admin/models').set('Cookie', cookie);
      expect(list.body.mappings[0].canonicalModel).toBe('qwen3.8:27b');
    });

    it('accepts a repeat of the identical mapping', async () => {
      await post({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
      const r = await post({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
      expect(r.status).toBe(201);
      const list = await supertest(app).get('/v1/admin/models').set('Cookie', cookie);
      expect(list.body.mappings).toHaveLength(1);
    });

    it('refuses to create a chain, which would leave a group that looks empty', async () => {
      await post({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
      const r = await post({ aliasModel: 'qwen-3.8-27b', canonicalModel: 'qwen38-27b' });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('qwen3.8:27b');
    });
  });

  describe('effect on PR Overview', () => {
    beforeEach(async () => {
      await supertest(app).post('/v1/admin/models/mappings').set('Cookie', cookie)
        .send({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });
    });

    it('combines the spellings into one row with the summed count', async () => {
      const r = await overview();
      const models = r.byModel.map((m: any) => m.model);
      expect(models).not.toContain('qwen38-27b');
      const qwen = r.byModel.find((m: any) => m.model === 'qwen3.8:27b');
      expect(qwen.prs).toBe(3); // 1 + 2, one row
      expect(r.totals.prs).toBe(4); // total unaffected — only grouping changed
    });

    it('still filters correctly by the OLD spelling (saved links keep working)', async () => {
      const r = await overview('?model=qwen38-27b');
      expect(r.totals.prs).toBe(3);
      expect(r.byModel).toHaveLength(1);
      expect(r.byModel[0].model).toBe('qwen3.8:27b');
    });

    it('filters by the new spelling too', async () => {
      const r = await overview('?model=qwen3.8:27b');
      expect(r.totals.prs).toBe(3);
    });

    it('leaves unmapped models alone', async () => {
      const r = await overview();
      expect(r.byModel.find((m: any) => m.model === 'glm-5.2').prs).toBe(1);
    });

    it('reverts when the mapping is deleted', async () => {
      const d = await supertest(app)
        .delete('/v1/admin/models/mappings/qwen38-27b').set('Cookie', cookie);
      expect(d.status).toBe(200);
      expect(d.body.removed).toBe(true);
      const r = await overview();
      expect(r.byModel.find((m: any) => m.model === 'qwen38-27b').prs).toBe(2);
    });
  });

  it('is org-scoped: another org sees neither the mapping nor its effect', async () => {
    await ctx.db.run(`INSERT INTO orgs (id, name) VALUES ('org-b', 'org-b')`);
    await createPasswordUser(ctx.db, 'org-b', 'adminb@x', 'longenough1', 'admin');
    const loginB = await supertest(app).post('/auth/login').send({ email: 'adminb@x', password: 'longenough1' });
    const cookieB = loginB.headers['set-cookie']?.[0] ?? '';

    await supertest(app).post('/v1/admin/models/mappings').set('Cookie', cookie)
      .send({ aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b' });

    const listB = await supertest(app).get('/v1/admin/models').set('Cookie', cookieB);
    expect(listB.body.mappings).toEqual([]);
    // org-b has no events at all, so the overview is empty rather than shared.
    const overviewB = await (await supertest(app).get('/v1/prs/overview').set('Cookie', cookieB)).body;
    expect(overviewB.totals.prs).toBe(0);
  });
});
