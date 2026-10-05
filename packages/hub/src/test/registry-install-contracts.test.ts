import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { issueApiKey } from '../auth/apiKey';
import { createPasswordUser } from '../auth/password';
import { saveRegistryConfig, serializeRegistryFlow } from '../services/flowRegistry';
import { loginAs } from './helpers/loginAs';

/**
 * CGLAB-385 (S9 review) — both hub install paths keep a registry flow's step
 * contract, anchors included, and the hub's publish route honours a deliberate
 * removal only when it is asked for explicitly.
 */
const SECRET = 'a'.repeat(64);
const REPO = 'acme-corp/agenfk-flows';

const REGISTRY_FLOW = {
  name: 'Contract Flow',
  description: 'has roles and checks',
  steps: [
    { name: 'TODO', label: 'To Do', isAnchor: true },
    { name: 'BUILD', label: 'Build', exitCriteria: 'it builds', role: 'coding', checks: [{ id: 'suite-green' }] },
    { name: 'DONE', label: 'Done', isAnchor: true, role: 'closing' },
  ],
};

const registryFile = (flow: unknown) => vi.fn(async (url: string) => {
  if (url.includes('/contents/flows/')) {
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify(flow)).toString('base64') }) };
  }
  throw new Error(`unexpected fetch ${url}`);
});

describe('hub registry installs keep the step contract', () => {
  let server: any;
  let db: any;
  let key: string;
  let cookieAdmin: string;

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a', db });
    server = out.app.listen(0);
    key = await issueApiKey(db, 'org-a', 'laptop', { installationId: 'inst-1' });
    await saveRegistryConfig(db, 'org-a', { repo: REPO, branch: 'main', token: 'ghp_x', secretKey: SECRET, copiedAt: null });
    await createPasswordUser(db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookieAdmin = await loginAs(out.app, 'admin@x', 'longenough1');
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    vi.unstubAllGlobals();
  });

  it('POST /v1/registry/flows/install hands back role and checks, on the middle steps and the anchors', async () => {
    vi.stubGlobal('fetch', registryFile(REGISTRY_FLOW));
    const r = await supertest(server).post('/v1/registry/flows/install').set('Authorization', `Bearer ${key}`).send({ filename: 'contract-flow.json' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const steps = r.body.flow.steps;
    expect(steps.find((s: any) => s.name === 'BUILD')).toMatchObject({ role: 'coding', checks: [{ id: 'suite-green' }] });
    expect(steps.find((s: any) => s.name === 'DONE')).toMatchObject({ isAnchor: true, role: 'closing' });
  });

  it('POST /v1/admin/flows/install persists role and checks, on the middle steps and the anchors', async () => {
    vi.stubGlobal('fetch', registryFile(REGISTRY_FLOW));
    const r = await supertest(server).post('/v1/admin/flows/install').set('Cookie', cookieAdmin).send({ filename: 'contract-flow.json' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const steps = r.body.definition.steps;
    expect(steps.find((s: any) => s.name === 'BUILD')).toMatchObject({ role: 'coding', checks: [{ id: 'suite-green' }] });
    expect(steps.find((s: any) => s.name === 'DONE')).toMatchObject({ isAnchor: true, role: 'closing' });
  });

  it('both install paths keep a registry flow\'s verifyAt (281adef0)', async () => {
    vi.stubGlobal('fetch', registryFile({ ...REGISTRY_FLOW, verifyAt: 'parent' }));
    const laptop = await supertest(server).post('/v1/registry/flows/install').set('Authorization', `Bearer ${key}`).send({ filename: 'contract-flow.json' });
    expect(laptop.body.flow.verifyAt).toBe('parent');
    const admin = await supertest(server).post('/v1/admin/flows/install').set('Cookie', cookieAdmin).send({ filename: 'contract-flow.json' });
    expect(admin.body.definition.verifyAt).toBe('parent');
  });

  it('POST /v1/admin/flows/install refuses an invalid contract whole, rather than installing it with parts dropped', async () => {
    vi.stubGlobal('fetch', registryFile({ ...REGISTRY_FLOW, steps: [{ name: 'BUILD', role: 'no-such-role' }] }));
    const r = await supertest(server).post('/v1/admin/flows/install').set('Cookie', cookieAdmin).send({ filename: 'bad.json' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/cannot be installed/);
  });

  describe('POST /v1/registry/flows/publish over a registry flow with a contract', () => {
    const BASE = 'b'.repeat(40);
    const githubWithRichBase = () => {
      const writes: string[] = [];
      const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
      const fn = vi.fn(async (url: string, init?: any) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const p = decodeURIComponent(new URL(url).pathname);
        if (method !== 'GET') writes.push(`${method} ${p}`);
        if (method === 'GET' && p.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: BASE } });
        if (method === 'GET' && p.includes('/git/ref/heads/flow/')) return res(404, {});
        if (method === 'GET' && p.includes('/contents/flows/')) return res(200, { sha: 'f'.repeat(40), content: Buffer.from(serializeRegistryFlow(REGISTRY_FLOW, 'someone')).toString('base64') });
        if (method === 'POST' && p.endsWith('/git/refs')) return res(201, {});
        if (method === 'PUT') return res(201, {});
        if (method === 'POST' && p.endsWith('/pulls')) return res(201, { html_url: `https://github.com/${REPO}/pull/1` });
        throw new Error(`unexpected ${method} ${p}`);
      });
      return { fn, writes };
    };
    const bare = { ...REGISTRY_FLOW, steps: REGISTRY_FLOW.steps.map(({ role, checks, ...s }: any, i) => ({ ...s, order: i })) };
    const publish = (body: object) => supertest(server).post('/v1/registry/flows/publish').set('Authorization', `Bearer ${key}`).send(body);

    it('refuses a stripped copy with 409', async () => {
      const g = githubWithRichBase();
      vi.stubGlobal('fetch', g.fn);
      const r = await publish({ flow: bare, publisher: 'dana' });
      expect(r.status).toBe(409);
      expect(g.writes).toEqual([]);
    });

    it('opens the pull request when allowContractRemoval is true', async () => {
      vi.stubGlobal('fetch', githubWithRichBase().fn);
      const r = await publish({ flow: bare, publisher: 'dana', allowContractRemoval: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.kind).toBe('pr');
    });

    it('does not take a truthy non-boolean as the explicit ask', async () => {
      vi.stubGlobal('fetch', githubWithRichBase().fn);
      expect((await publish({ flow: bare, publisher: 'dana', allowContractRemoval: 'yes' })).status).toBe(409);
    });
  });
});
