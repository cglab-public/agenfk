import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-flows-registry-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

describe('hub admin: built-in default flow + registry proxy + install', () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let cookieView: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x',  'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView  = await loginAs(app, 'view@x',  'longenough1');
  });

  afterEach(async () => {
    await ctx.db.close();
    cleanup();
    vi.unstubAllGlobals();
  });

  // ── /v1/admin/flows/default ───────────────────────────────────────────────
  it('GET /v1/admin/flows/default returns the built-in flow', async () => {
    const r = await supertest(app).get('/v1/admin/flows/default').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(typeof r.body.name).toBe('string');
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps.length).toBeGreaterThan(0);
  });

  it('GET /v1/admin/flows/default rejects non-admin', async () => {
    const r = await supertest(app).get('/v1/admin/flows/default').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  // ── /v1/admin/registry/flows ──────────────────────────────────────────────
  it('GET /v1/admin/registry/flows proxies the GitHub registry', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes('/contents/flows?')) {
        return {
          ok: true, status: 200,
          json: async () => [
            { name: 'one.json', type: 'file', download_url: 'https://x.test/one.json' },
            { name: 'two.json', type: 'file', download_url: 'https://x.test/two.json' },
            { name: 'README.md', type: 'file', download_url: 'https://x.test/README.md' },
          ],
        };
      }
      if (url === 'https://x.test/one.json') {
        return { ok: true, status: 200, json: async () => ({ name: 'One', steps: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }] }) };
      }
      if (url === 'https://x.test/two.json') {
        return { ok: true, status: 200, json: async () => ({ name: 'Two', author: 'alice', steps: [{ name: 'x', label: 'X' }] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fakeFetch);

    const r = await supertest(app).get('/v1/admin/registry/flows').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0].name).toBe('One');
    expect(r.body[0].stepCount).toBe(2);
    expect(r.body[1].author).toBe('alice');
  });

  it('GET /v1/admin/registry/flows returns [] when registry directory is missing (404)', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal('fetch', fakeFetch);
    const r = await supertest(app).get('/v1/admin/registry/flows').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('GET /v1/admin/registry/flows rejects non-admin', async () => {
    const r = await supertest(app).get('/v1/admin/registry/flows').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  // ── /v1/admin/flows/install ───────────────────────────────────────────────
  it('POST /v1/admin/flows/install fetches a registry file and persists with source=community', async () => {
    const flowJson = {
      name: 'Imported Flow',
      description: 'from the registry',
      steps: [
        { name: 'TODO', label: 'TODO', isAnchor: true },
        { name: 'WORK', label: 'Work', exitCriteria: 'done' },
        { name: 'DONE', label: 'DONE', isAnchor: true },
      ],
    };
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes(`/contents/flows/${encodeURIComponent('community.json')}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ content: Buffer.from(JSON.stringify(flowJson)).toString('base64'), encoding: 'base64' }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fakeFetch);

    const r = await supertest(app).post('/v1/admin/flows/install').set('Cookie', cookieAdmin)
      .send({ filename: 'community.json' });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe('community');
    expect(r.body.name).toBe('Imported Flow');
    expect(r.body.definition.steps.length).toBeGreaterThan(0);

    // Should be visible in the list now.
    const list = await supertest(app).get('/v1/admin/flows').set('Cookie', cookieAdmin);
    expect(list.body.find((f: any) => f.name === 'Imported Flow')).toBeTruthy();
  });

  it('POST /v1/admin/flows/install requires a filename', async () => {
    const r = await supertest(app).post('/v1/admin/flows/install').set('Cookie', cookieAdmin).send({});
    expect(r.status).toBe(400);
  });

  it('POST /v1/admin/flows/install rejects non-admin', async () => {
    const r = await supertest(app).post('/v1/admin/flows/install').set('Cookie', cookieView)
      .send({ filename: 'whatever.json' });
    expect(r.status).toBe(403);
  });
});
