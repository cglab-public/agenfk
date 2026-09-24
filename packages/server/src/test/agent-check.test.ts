/**
 * efcacdeb (C3) - an agent-run check: the step's instruction, carried out by
 * the coding agent and reported with verify; labelled agent-reported.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./agent-check-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-agentcheck-pk-'));
const STORE = path.join(STORE_DIR, 'passkeys.json');
process.env.AGENFK_PASSKEY_STORE = STORE;

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { SoftAuthenticator } from './softAuthenticator';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of [...repos, STORE_DIR]) fs.rmSync(r, { recursive: true, force: true });
});
beforeEach(() => { fs.rmSync(STORE, { force: true }); });

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const board = () => ({ 'x-agenfk-ui': '1' });

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
const flowWith = (checks: unknown[]) => [s('START', 0, { isAnchor: true }), s('WORK', 1, { checks }), s('NEXT', 2), s('END', 3, { isAnchor: true })];
const DOCS = { id: 'agent-check', params: { name: 'docs', instruction: 'Check the README documents every new CLI flag.' } };
const CHANGELOG = { id: 'agent-check', params: { name: 'changelog', instruction: 'Add a CHANGELOG line.' } };

/** A card on WORK of a project whose flow carries `checks`; `root: false` gives it no tree. */
async function onWork(checks: unknown[], { root = true, origin }: { root?: boolean; origin?: string } = {}) {
  const f = await agent().post('/flows').send({ name: `cmd-${++seq}`, steps: flowWith(checks) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  if (origin) await storage.updateFlow(f.body.id, { origin } as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cmd-repo-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > marker && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `cmd-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, ...(root ? { projectRoot: dir } : {}) } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `cmd-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return { id: c.body.id as string, pid: p.body.id as string, dir };
}
const validate = (id: string, agentChecks?: unknown) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...(agentChecks ? { agentChecks } : {}) });

const after = async (id: string, agentChecks?: unknown) => {
  const r = await validate(id, agentChecks);
  const item = (await agent().get(`/items/${id}`)).body;
  const byId = (x: string) => (item.lastChecks?.results ?? []).find((c: any) => c.id === x);
  return { r, item, moved: item.status !== 'WORK', byId };
};

describe('efcacdeb (C3): an agent-run check', () => {
  it('blocks until the agent reports it, telling it what to do and how to report', async () => {
    const { id } = await onWork([DOCS]);
    const { r, byId, moved } = await after(id);
    expect(r.status).toBe(422);
    expect(moved).toBe(false);
    const c = byId('agent-check:docs');
    expect(c).toMatchObject({ outcome: 'fail', blocking: true, agentReported: true });
    expect(c.detail).toContain(DOCS.params.instruction);
    expect(c.detail).toContain(`agenfk verify ${id} --check docs=pass`);
  });

  it('passes on a pass report, labelled agent-reported, and the card moves', async () => {
    const { id } = await onWork([DOCS]);
    const { byId, moved } = await after(id, [{ name: 'docs', outcome: 'pass', note: 'README lists --check' }]);
    expect(byId('agent-check:docs')).toMatchObject({ outcome: 'pass', agentReported: true });
    expect(byId('agent-check:docs').detail).toMatch(/agent-reported/);
    expect(byId('agent-check:docs').detail).toMatch(/README lists --check/);
    expect(moved).toBe(true);
  });

  it('blocks on a fail report, with the agent\'s note', async () => {
    const { id } = await onWork([DOCS]);
    const { byId, moved } = await after(id, [{ name: 'docs', outcome: 'fail', note: 'two flags undocumented' }]);
    expect(byId('agent-check:docs')).toMatchObject({ outcome: 'fail', blocking: true });
    expect(byId('agent-check:docs').detail).toMatch(/two flags undocumented/);
    expect(moved).toBe(false);
  });

  it('holds the card on the one not reported, when a step has two', async () => {
    const { id } = await onWork([DOCS, CHANGELOG]);
    const { byId, moved } = await after(id, [{ name: 'docs', outcome: 'pass' }]);
    expect(byId('agent-check:docs').outcome).toBe('pass');
    expect(byId('agent-check:changelog')).toMatchObject({ outcome: 'fail', blocking: true });
    expect(moved).toBe(false);
  });

  it('refuses a report for an agent check the step does not have, naming the ones it has', async () => {
    const { id } = await onWork([DOCS]);
    const r = await validate(id, [{ name: 'lint', outcome: 'pass' }]);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/lint/);
    expect(JSON.stringify(r.body)).toMatch(/docs/);
  });

  it('refuses a malformed report', async () => {
    const { id } = await onWork([DOCS]);
    expect((await validate(id, [{ name: 'docs', outcome: 'maybe' }])).status).toBe(400);
    expect((await validate(id, { docs: 'pass' })).status).toBe(400);
  });

  it('keeps the report in the check history, labelled', async () => {
    const { id } = await onWork([DOCS]);
    await after(id, [{ name: 'docs', outcome: 'pass' }]);
    const h = (await agent().get(`/items/${id}/check-history`)).body;
    const run = h.find((e: any) => e.kind === 'verify' && e.step === 'WORK');
    expect(run.results.find((x: any) => x.id === 'agent-check:docs')).toMatchObject({ outcome: 'pass', agentReported: true });
  });
});
