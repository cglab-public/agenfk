/**
 * Admin model-meta configuration (CGLAB-133 follow-up).
 *
 * The point of these tests is that the classification is CONFIGURABLE: the
 * table seeds itself so the feature works out of the box, and after that an
 * admin edit is what the dashboard shows — not the seed. A regression here
 * means the Admin page looks like it saved but the PR Overview keeps using the
 * shipped values, which is the failure mode that makes a settings UI worse than
 * no settings UI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-model-meta-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

describe('admin model_meta', () => {
  let app: any;
  let ctx: any;
  let cookie: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
  });

  afterEach(async () => {
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  const get = (url: string) => supertest(app).get(url).set('Cookie', cookie);
  const put = (url: string, body: any) => supertest(app).put(url).set('Cookie', cookie).send(body);
  const del = (url: string) => supertest(app).delete(url).set('Cookie', cookie);

  describe('automatic seeding', () => {
    it('seeds the table on first read without any admin action', async () => {
      const r = await get('/v1/admin/models');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.meta)).toBe(true);
      expect(r.body.meta.length).toBeGreaterThan(50);

      const claude = r.body.meta.find((m: any) => m.model === 'claude');
      expect(claude).toMatchObject({ provider: 'Anthropic', licenseClass: 'commercial', source: 'seed' });
    });

    it('seeds exactly once — a second read does not duplicate or reset rows', async () => {
      const first = await get('/v1/admin/models');
      const second = await get('/v1/admin/models');
      expect(second.body.meta.length).toBe(first.body.meta.length);
    });

    it('does not re-seed over an admin edit on subsequent reads', async () => {
      await put('/v1/admin/models/meta', {
        model: 'claude', provider: 'Anthropic PBC', licenseClass: 'commercial', license: 'Commercial',
      }).expect(201);

      const r = await get('/v1/admin/models');
      const row = r.body.meta.find((m: any) => m.model === 'claude');
      expect(row.provider).toBe('Anthropic PBC');
      expect(row.source).toBe('admin');
    });

    it('seeds only the reading org — a second org gets its own rows', async () => {
      // Seeding is lazy (on first read), so this must go through the endpoint
      // rather than querying the table, which is legitimately empty until
      // someone reads it.
      await get('/v1/admin/models').expect(200);

      const orgs = await ctx.db.all<{ org_id: string }>(
        'SELECT DISTINCT org_id FROM model_meta ORDER BY org_id');
      expect(orgs.map(o => o.org_id)).toEqual(['org']);

      // A different org reading the same table triggers its own seed pass; the
      // per-org key is what keeps the two independent.
      await ctx.db.run(
        `INSERT INTO model_meta (org_id, model, provider, license_class, license, source)
         VALUES ('other-org', 'glm-5.2', 'Custom', 'commercial', 'X', 'admin')`);
      const other = await ctx.db.all<{ c: number | string }>(
        'SELECT COUNT(*) AS c FROM model_meta WHERE org_id = ?', ['other-org']);
      expect(Number(other[0].c)).toBe(1);

      // The seeded org is untouched by the other org's single row.
      const mine = await ctx.db.all<{ c: number | string }>(
        'SELECT COUNT(*) AS c FROM model_meta WHERE org_id = ?', ['org']);
      expect(Number(mine[0].c)).toBeGreaterThan(50);
    });
  });

  describe('PUT /v1/admin/models/meta', () => {
    it('creates a row for a model the seed does not cover', async () => {
      await put('/v1/admin/models/meta', {
        model: 'brand-x-1', provider: 'Brand X', licenseClass: 'open_weights', license: 'MIT',
      }).expect(201);
      const r = await get('/v1/admin/models');
      expect(r.body.meta.find((m: any) => m.model === 'brand-x-1')).toMatchObject({
        provider: 'Brand X', licenseClass: 'open_weights', source: 'admin',
      });
    });

    it('overrides a seeded row and marks it admin-sourced', async () => {
      await put('/v1/admin/models/meta', {
        model: 'glm-5.2', provider: 'Z.ai', licenseClass: 'commercial', license: 'Changed by admin',
      }).expect(201);
      const r = await get('/v1/admin/models');
      expect(r.body.meta.find((m: any) => m.model === 'glm-5.2').licenseClass).toBe('commercial');
    });

    it('is idempotent — saving the same values twice leaves one row', async () => {
      const body = { model: 'dup-model', provider: 'Dup', licenseClass: 'open_weights', license: 'MIT' };
      await put('/v1/admin/models/meta', body).expect(201);
      await put('/v1/admin/models/meta', body).expect(201);
      const rows = await ctx.db.all<{ c: number | string }>(
        'SELECT COUNT(*) AS c FROM model_meta WHERE org_id = ? AND model = ?', ['org', 'dup-model']);
      expect(Number(rows[0].c)).toBe(1);
    });

    it('rejects a missing or blank field rather than storing an empty chip', async () => {
      for (const body of [
        { model: '', provider: 'X', licenseClass: 'commercial', license: 'MIT' },
        { model: 'x', provider: '', licenseClass: 'commercial', license: 'MIT' },
        { model: 'x', provider: 'X', licenseClass: 'commercial', license: '' },
        { model: 'x', provider: 'X', licenseClass: 'open_weights' },
      ]) {
        const r = await put('/v1/admin/models/meta', body);
        expect(r.status).toBe(400);
      }
    });

    it('rejects a licenseClass outside the two valid values', async () => {
      const r = await put('/v1/admin/models/meta', {
        model: 'x', provider: 'X', licenseClass: 'open_source', license: 'MIT',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/open_weights/);
    });

    it('rejects a harness name — it is a runtime, not a model', () =>
      put('/v1/admin/models/meta', {
        model: 'claude-code', provider: 'Anthropic', licenseClass: 'commercial', license: 'X',
      }).expect(400));

    it('rejects an over-long model id', async () => {
      const r = await put('/v1/admin/models/meta', {
        model: 'z'.repeat(300), provider: 'X', licenseClass: 'commercial', license: 'MIT',
      });
      expect(r.status).toBe(400);
    });

    it('requires an admin session', async () => {
      const r = await supertest(app).put('/v1/admin/models/meta').send({
        model: 'x', provider: 'X', licenseClass: 'commercial', license: 'MIT',
      });
      expect([401, 403]).toContain(r.status);
    });
  });

  describe('DELETE /v1/admin/models/meta/:model', () => {
    it('removes a row', async () => {
      await put('/v1/admin/models/meta', {
        model: 'gone-model', provider: 'Gone', licenseClass: 'commercial', license: 'MIT',
      }).expect(201);
      const r = await del(`/v1/admin/models/meta/${encodeURIComponent('gone-model')}`);
      expect(r.body.removed).toBe(true);
      const after = await get('/v1/admin/models');
      expect(after.body.meta.find((m: any) => m.model === 'gone-model')).toBeUndefined();
    });

    it('reports removed:false for an unknown model rather than erroring', async () => {
      const r = await del('/v1/admin/models/meta/nope-not-here');
      expect(r.status).toBe(200);
      expect(r.body.removed).toBe(false);
    });

    it('a deleted row is not resurrected by the next read', async () => {
      await del(`/v1/admin/models/meta/${encodeURIComponent('glm-5.2')}`).expect(200);
      const r = await get('/v1/admin/models');
      expect(r.body.meta.find((m: any) => m.model === 'glm-5.2')).toBeUndefined();
    });
  });

  describe('the dashboard reads the table, not the seed', () => {
    const prEvent = (model: string) => ({
      eventId: `e-${Math.random().toString(36).slice(2)}`,
      installationId: 'inst-1',
      orgId: 'org',
      occurredAt: new Date().toISOString(),
      actor: { osUser: 'tester', gitName: null, gitEmail: null },
      type: 'pr.opened',
      projectId: 'p1',
      itemId: 'i1',
      payload: { repo: 'acme/api', prNumber: 1, model, leafStory: 1, bug: 0 },
    });

    const token = async () => {
      const { issueApiKey } = await import('../auth/apiKey');
      return issueApiKey(ctx.db, 'org', 'k', { installationId: 'inst-1' } as any);
    };

    const byModel = async (model: string) => {
      const r = await get('/v1/prs/overview');
      return (r.body.byModel ?? []).find((m: any) => m.model === model);
    };

    it('returns provider/licenseClass on byModel from the seeded table', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('glm-5.2')] });

      const row = await byModel('glm-5.2');
      expect(row).toBeDefined();
      expect(row.provider).toBe('Z.ai');
      expect(row.licenseClass).toBe('open_weights');
    });

    it('reflects an admin edit on the next dashboard load', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('glm-5.2')] });

      await put('/v1/admin/models/meta', {
        model: 'glm-5.2', provider: 'Z.ai', licenseClass: 'commercial', license: 'Admin override',
      }).expect(201);

      const row = await byModel('glm-5.2');
      expect(row.licenseClass).toBe('commercial');
      expect(row.license).toBe('Admin override');
    });

    it('marks an unknown model unclassified rather than guessing', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('totally-unknown-model-9000')] });

      const row = await byModel('totally-unknown-model-9000');
      expect(row.provider).toBe('unclassified');
    });

    it('classifies a router-prefixed id by its artifact, not the reseller', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('@cf/zai-org/glm-5.2')] });

      const row = await byModel('@cf/zai-org/glm-5.2');
      expect(row.provider).toBe('Z.ai');
      expect(row.licenseClass).toBe('open_weights');
    });

    it('never classifies a harness name as a model', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('claude-code')] });

      const row = await byModel('claude-code');
      expect(row.provider).toBe('unclassified');
    });
    /**
     * The bug: model_meta is resolved from the RAW reported id, but byModel is
     * keyed by the CANONICAL name after alias resolution. With a mapping in
     * place the canonical lookup found nothing, so the row shipped with no
     * provider/licenseClass and the UI rendered a model that had a perfectly
     * good seed row as "Unclassified / Commercial" — while its unmapped
     * siblings classified fine. That inconsistency is what made it look like a
     * data problem rather than a join bug.
     */
    it('attaches provider to a model reached through a mapping', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('deepseek/deepseek-v4-pro-0813')] });
      await supertest(app).post('/v1/admin/models/mappings').set('Cookie', cookie)
        .send({ aliasModel: 'deepseek/deepseek-v4-pro-0813', canonicalModel: 'deepseek-v4-pro-0813' });

      const row = await byModel('deepseek-v4-pro-0813');
      expect(row?.provider).toBe('DeepSeek');
      expect(row?.licenseClass).toBe('open_weights');
    });

    it('attaches metadata through a router-prefixed alias the seed matches by prefix', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('@cf/zai-org/glm-5.2')] });
      await supertest(app).post('/v1/admin/models/mappings').set('Cookie', cookie)
        .send({ aliasModel: '@cf/zai-org/glm-5.2', canonicalModel: 'glm-5.2' });
      const row = await byModel('glm-5.2');
      expect(row?.provider).toBe('Z.ai');
    });

    it('leaves a genuinely unknown model without provider metadata', async () => {
      await supertest(app)
        .post('/v1/events').set('Authorization', `Bearer ${await token()}`)
        .send({ events: [prEvent('totally-new-9000')] });
      const row = await byModel('totally-new-9000');
      expect(row).toBeDefined();
      // Explicitly 'unclassified', not omitted and not guessed. The UI needs a
      // value to put in a facet; what it must never do is turn the gap into
      // 'commercial'.
      expect(row?.provider).toBe('unclassified');
      expect(row?.licenseClass).toBe('unclassified');
    });
  });

});
