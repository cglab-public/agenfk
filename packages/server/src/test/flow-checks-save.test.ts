/**
 * @file CGLAB-380 (S4-T1) — every path that persists a flow on the local
 * server validates step roles and checks, and a PUT that omits them keeps
 * what is stored (absent is not clear, S9 row C).
 *
 * The paths: POST /flows, PUT /flows/:id, the public registry install, and the
 * hub flow sync. A flow that fails validation is refused whole, naming the
 * check and the missing record — never stored with the bad part dropped, which
 * would run a flow its author did not write.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./flow-checks-save-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import axios from 'axios';
import { app, initStorage } from '../server';
import { reconcileHubFlow } from '../hub/flowSync';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const tddSteps = () => [
  { id: 'a', name: 'START', label: 'Start', order: 0, isAnchor: true },
  { id: 'b', name: 'WRITE_SPECS', label: 'Specs', order: 1, role: 'test-authoring' },
  { id: 'c', name: 'BUILD', label: 'Build', order: 2, role: 'coding', checks: [{ id: 'jira-key-valid' }] },
  { id: 'd', name: 'FINISHED', label: 'Done', order: 3, isAnchor: true, role: 'closing' },
];
/** red-set-passes-by-name with nothing earlier producing a red set. */
const orphanSteps = () => [
  { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 'b', name: 'IN_PROGRESS', label: 'In Progress', order: 1, role: 'coding', checks: [{ id: 'red-set-passes-by-name' }] },
  { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
];

describe('POST /flows', () => {
  it('stores roles and checks and returns them', async () => {
    const res = await agent().post('/flows').send({ name: 'tdd-roles', steps: tddSteps() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const got = await agent().get(`/flows/${res.body.id}`);
    const build = got.body.steps.find((s: any) => s.name === 'BUILD');
    expect(build.role).toBe('coding');
    expect(build.checks).toEqual([{ id: 'jira-key-valid' }]);
  });

  it('refuses a check whose record no earlier step produces, naming check and record', async () => {
    const res = await agent().post('/flows').send({ name: 'orphan', steps: orphanSteps() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/red-set-passes-by-name/);
    expect(res.body.error).toMatch(/redSet/);
  });

  it('refuses an unknown check id', async () => {
    const steps = tddSteps();
    (steps[2] as any).checks = [{ id: 'looks-good-to-me' }];
    const res = await agent().post('/flows').send({ name: 'unknown', steps });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/looks-good-to-me/);
  });
});

describe('PUT /flows/:id', () => {
  let flowId: string;
  beforeEach(async () => {
    const res = await agent().post('/flows').send({ name: `put-${Math.random()}`, steps: tddSteps() });
    expect(res.status).toBe(201);
    flowId = res.body.id;
  });

  it('a step that omits role/checks keeps them: an older editor never wipes a contract', async () => {
    const stripped = tddSteps().map(({ role, checks, ...rest }: any) => ({ ...rest, label: `${rest.label}!` }));
    const res = await agent().put(`/flows/${flowId}`).send({ steps: stripped });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const build = res.body.steps.find((s: any) => s.name === 'BUILD');
    expect(build.label).toBe('Build!');
    expect(build.role).toBe('coding');
    expect(build.checks).toEqual([{ id: 'jira-key-valid' }]);
  });

  it('an explicit null clears', async () => {
    const steps = tddSteps().map((s: any) => (s.id === 'c' ? { ...s, role: null, checks: null } : s));
    const res = await agent().put(`/flows/${flowId}`).send({ steps });
    expect(res.status).toBe(200);
    const build = res.body.steps.find((s: any) => s.name === 'BUILD');
    expect(build.role ?? null).toBeNull();
    expect(build.checks ?? null).toBeNull();
  });

  it('refuses an invalid contract and leaves the stored flow alone', async () => {
    const res = await agent().put(`/flows/${flowId}`).send({ steps: orphanSteps() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redSet/);
    const got = await agent().get(`/flows/${flowId}`);
    expect(got.body.steps.map((s: any) => s.name)).toEqual(['START', 'WRITE_SPECS', 'BUILD', 'FINISHED']);
  });

  it('validates the MERGED steps: dropping the producer\'s role while a consumer stays is refused', async () => {
    // Keep BUILD's stored role (absent), clear WRITE_SPECS' role, and add a
    // consumer on BUILD that now has no producer.
    const steps = tddSteps().map((s: any) => {
      if (s.id === 'b') return { ...s, role: null };
      if (s.id === 'c') { const { role, ...rest } = s; return { ...rest, checks: [{ id: 'red-set-passes-by-name' }] }; }
      return s;
    });
    const res = await agent().put(`/flows/${flowId}`).send({ steps });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/redSet/);
  });
});

describe('POST /registry/flows/install (public registry)', () => {
  const content = (steps: object[]) => Buffer.from(JSON.stringify({ name: 'Community', steps })).toString('base64');

  it('carries roles and checks through', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        content: content([
          { name: 'WRITE_SPECS', label: 'Specs', order: 1, role: 'test-authoring' },
          { name: 'BUILD', label: 'Build', order: 2, role: 'coding', checks: [{ id: 'jira-key-valid' }] },
        ]),
      },
    });
    const res = await agent().post('/registry/flows/install').send({ filename: 'tdd.json' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const build = res.body.steps.find((s: any) => s.name === 'BUILD');
    expect(build.role).toBe('coding');
    expect(build.checks).toEqual([{ id: 'jira-key-valid' }]);
  });

  it('refuses an invalid contract and installs nothing', async () => {
    const before = (await agent().get('/flows')).body.length;
    vi.mocked(axios.get).mockResolvedValue({
      data: { content: content([{ name: 'IN_PROGRESS', label: 'In Progress', order: 1, role: 'coding', checks: [{ id: 'red-set-passes-by-name' }] }]) },
    });
    const res = await agent().post('/registry/flows/install').send({ filename: 'bad.json' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/redSet/);
    expect((await agent().get('/flows')).body.length).toBe(before);
  });
});

describe('hub flow sync', () => {
  let storage: SQLiteStorageProvider;
  let dbPath: string;
  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `flow-checks-sync-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
    storage = new SQLiteStorageProvider();
    await storage.init({ path: dbPath });
  });
  afterAll(() => { if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath); });

  const fetchOnce = (flow: any) => vi.fn(async () => ({
    status: 200, ok: true,
    headers: { get: () => 'W/"1"' },
    json: async () => ({ flow, hubVersion: 1 }),
  })) as any;
  const hubConfig = { url: 'http://hub.example.test', token: 't', orgId: 'o' };

  it('keeps roles and checks from the hub', async () => {
    const out = await reconcileHubFlow({ storage, hubConfig, lastEtag: null, fetchImpl: fetchOnce({ id: 'r1', name: 'Org', steps: tddSteps() }), emit: vi.fn() } as any);
    expect(out.outcome).toBe('updated');
    const [flow] = await storage.listFlows();
    expect((flow.steps.find(s => s.name === 'BUILD') as any).checks).toEqual([{ id: 'jira-key-valid' }]);
  });

  it('refuses an invalid hub flow: nothing is stored, and the outcome says why', async () => {
    const out = await reconcileHubFlow({ storage, hubConfig, lastEtag: null, fetchImpl: fetchOnce({ id: 'r2', name: 'Bad', steps: orphanSteps() }), emit: vi.fn() } as any);
    expect(out.outcome).toBe('error');
    expect((out as any).error).toMatch(/redSet/);
    expect(await storage.listFlows()).toHaveLength(0);
  });
});
