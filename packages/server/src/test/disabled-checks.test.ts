/**
 * @file CGLAB-428 — checks a hub admin switched off on a step.
 *
 *  - The hub sync keeps a step's `disabledChecks`; a hub flow that would
 *    switch off a human approval is refused like any invalid contract.
 *  - A flow authored here (POST/PUT /flows) may not carry the field: only the
 *    org's hub may remove a safeguard.
 *  - A verify on a hub flow does not run a disabled check, and says so on the
 *    reply, on the card's gates and in the PR history - never silently.
 *  - The same steps on a flow that did NOT come from the hub still run it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./disabled-checks-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { reconcileHubFlow } from '../hub/flowSync';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });
const FAIL = [process.execPath, '-e', 'process.exit(1)'];
const failing = { id: 'command-check', params: { name: 'lint', argv: FAIL } };
const steps = (work: Record<string, unknown> = {}) => [
  s('TODO', 0, { isAnchor: true }), s('WORK', 1, { checks: [failing], ...work }), s('NEXT', 2), s('DONE', 3, { isAnchor: true }),
];

/** A flow stored as the hub sync (source 'hub') or a local edit would store it. */
async function flowRow(source: 'hub' | 'local', work: Record<string, unknown>) {
  const id = randomUUID();
  await storage.createFlow({ id, name: `dc-${++seq}`, description: '', version: '1.0.0', steps: steps(work), createdAt: new Date(), updatedAt: new Date(), source, ...(source === 'hub' ? { hubFlowId: `remote-${seq}`, hubVersion: 1 } : {}) } as any);
  return id;
}
async function project(flowId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-dc-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `dc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return p.body.id as string;
}
async function card(projectId: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId, ...extra });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const text = (body: any) => JSON.stringify(body);

describe('a flow authored here may not switch checks off', () => {
  it('POST /flows refuses a step carrying disabledChecks, naming the hub', async () => {
    const r = await agent().post('/flows').send({ name: `dc-${++seq}`, steps: steps({ disabledChecks: ['command-check:lint'] }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/disabledChecks/);
    expect(r.body.error).toMatch(/hub/i);
  });

  it('PUT /flows/:id refuses it too', async () => {
    const created = await agent().post('/flows').send({ name: `dc-${++seq}`, steps: steps() });
    expect(created.status, text(created.body)).toBe(201);
    const withIds = created.body.steps.map((st: any) => (st.name === 'WORK' ? { ...st, disabledChecks: ['command-check:lint'] } : st));
    const r = await agent().put(`/flows/${created.body.id}`).send({ steps: withIds });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/disabledChecks/);
    expect((await storage.getFlow(created.body.id))!.steps.some((st: any) => st.disabledChecks)).toBe(false);
  });

  it('an empty list is no request to switch anything off, and is accepted', async () => {
    const r = await agent().post('/flows').send({ name: `dc-${++seq}`, steps: steps({ disabledChecks: [] }) });
    expect(r.status, text(r.body)).toBe(201);
  });
});

describe('a verify on a hub flow does not run a disabled check', () => {
  it('passes a step whose only failing check the hub switched off, and says so on the reply', async () => {
    const pid = await project(await flowRow('hub', { disabledChecks: ['command-check:lint'] }));
    const id = await card(pid);
    const r = await validate(id);
    expect(r.status, text(r.body)).toBe(200);
    expect((await storage.getItem(id))!.status).toBe('NEXT');
    expect(r.body.message).toMatch(/switched off/i);
    expect(r.body.message).toMatch(/command-check:lint/);
  });

  it('still runs it on a flow that did not come from the hub', async () => {
    const pid = await project(await flowRow('local', { disabledChecks: ['command-check:lint'] }));
    const id = await card(pid);
    const r = await validate(id);
    expect(r.status, text(r.body)).toBe(422);
    expect(r.body.checks.map((c: any) => c.id)).toContain('command-check:lint');
    expect((await storage.getItem(id))!.status).toBe('WORK');
  });

  it("names a refused step's disabled checks too", async () => {
    // jira-key-valid stays on and fails: the card carries no JIRA key.
    const pid = await project(await flowRow('hub', { disabledChecks: ['command-check:lint'], checks: [failing, { id: 'jira-key-valid' }] }));
    const id = await card(pid);
    const r = await validate(id);
    expect(r.status, text(r.body)).toBe(422);
    expect(r.body.message).toMatch(/switched off/i);
    expect(r.body.message).toMatch(/command-check:lint/);
  });

  it('lists the disabled checks on GET /items/:id/gates', async () => {
    const pid = await project(await flowRow('hub', { disabledChecks: ['command-check:lint', 'on-card-branch'] }));
    const id = await card(pid);
    const g = await agent().get(`/items/${id}/gates`);
    expect(g.status).toBe(200);
    expect(g.body.disabledChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'command-check:lint', source: 'flow' }),
      expect.objectContaining({ id: 'on-card-branch', source: 'universal' }),
    ]));
  });

  it('gives GET /items/:id/gates an empty list when nothing is switched off', async () => {
    const pid = await project(await flowRow('hub', {}));
    const g = await agent().get(`/items/${await card(pid)}/gates`);
    expect(g.body.disabledChecks).toEqual([]);
  });

  it('lists, for the PR, the checks each card of the tree left a step with switched off', async () => {
    const pid = await project(await flowRow('hub', { disabledChecks: ['command-check:lint'] }));
    const parent = await card(pid);
    const child = await card(pid, { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    const r = await agent().get(`/items/${parent}/disabled-checks`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([expect.objectContaining({ itemId: child, step: 'WORK', check: 'command-check:lint', source: 'flow' })]);
  });

  it('404s the PR listing for a card that does not exist', async () => {
    expect((await agent().get(`/items/${randomUUID()}/disabled-checks`)).status).toBe(404);
  });
});

describe('the hub sync', () => {
  const fetchOf = (flow: any) => vi.fn(async () => ({
    status: 200, ok: true, headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? `W/"${++seq}"` : null) }, json: async () => ({ flow, hubVersion: 2 }),
  })) as any;

  it("keeps a step's disabledChecks on the flow it installs", async () => {
    const remote = { id: `remote-sync-${++seq}`, name: 'Org', description: '', steps: steps({ disabledChecks: ['command-check:lint'] }) };
    const out = await reconcileHubFlow({ storage, hubConfig: { url: 'http://hub.test', token: 't', orgId: 'o' }, lastEtag: null, fetchImpl: fetchOf(remote), emit: vi.fn() } as any);
    expect(out.outcome).toBe('updated');
    const local = (await storage.listFlows()).find(f => f.hubFlowId === remote.id)!;
    expect(local.source).toBe('hub');
    expect(local.steps.find(st => st.name === 'WORK')!.disabledChecks).toEqual(['command-check:lint']);
  });

  it('refuses a hub flow that would switch off a human approval', async () => {
    const remote = { id: `remote-sync-${++seq}`, name: 'Org', description: '', steps: steps({ checks: [{ id: 'human-approval' }], disabledChecks: ['human-approval'] }) };
    const out = await reconcileHubFlow({ storage, hubConfig: { url: 'http://hub.test', token: 't', orgId: 'o' }, lastEtag: null, fetchImpl: fetchOf(remote), emit: vi.fn() } as any);
    expect(out.outcome).toBe('error');
    expect((out as { error?: string }).error).toMatch(/human-approval/);
    expect((await storage.listFlows()).some(f => f.hubFlowId === remote.id)).toBe(false);
  });
});
