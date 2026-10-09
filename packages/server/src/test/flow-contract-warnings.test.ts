/**
 * @file CGLAB-457 (T3) — where the flow lint is seen: on the save that makes a
 * flow, and on the verify that brings a card onto a step whose words ask for a
 * check it does not carry. Warnings only: nothing is refused, nothing switched on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { testDbPath } from './helpers/testDb';
import { v4 as uuidv4 } from 'uuid';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('flow-contract-warnings-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const cleanup: string[] = [];
const savedHome = process.env.HOME;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fcw-home-'));
  cleanup.push(home);
  process.env.HOME = home;
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  process.env.HOME = savedHome;
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });
const UNCHECKED = () => [
  s('TODO', 0, { isAnchor: true }),
  s('WORK', 1),
  s('REVIEW', 2, { exitCriteria: 'Review the code in a separate adversarial agent.' }),
  s('DONE', 3, { isAnchor: true, role: 'closing' }),
];

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fcw-repo-'));
  cleanup.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}
async function cardOnWork(flowId: string) {
  const p = await agent().post('/projects').send({ name: `fcw-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: repo(), flowId, verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return c.body.id as string;
}

describe('CGLAB-457: flow lint on save', () => {
  it('POST /flows answers with the warnings, and still creates the flow', async () => {
    const res = await agent().post('/flows').send({ name: `fcw-${++seq}`, steps: UNCHECKED() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.contractWarnings).toEqual([expect.objectContaining({ step: 'REVIEW', kind: 'review' })]);
    expect((await agent().get(`/flows/${res.body.id}`)).body.contractWarnings).toBeUndefined();
  });

  it('PUT /flows/:id answers with the warnings of the flow as saved', async () => {
    const created = await agent().post('/flows').send({ name: `fcw-${++seq}`, steps: [s('TODO', 0, { isAnchor: true }), s('WORK', 1, { role: 'coding' }), s('DONE', 2, { isAnchor: true, role: 'closing' })] });
    expect(created.body.contractWarnings).toEqual([]);
    const res = await agent().put(`/flows/${created.body.id}`).send({ steps: UNCHECKED() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.contractWarnings.map((w: any) => w.step)).toEqual(['REVIEW']);
  });
});

describe('CGLAB-457: flow lint on the verify that enters the step', () => {
  it('warns, naming the step and what to give it, and the card still moves', async () => {
    const flow = await agent().post('/flows').send({ name: `fcw-${++seq}`, steps: UNCHECKED() });
    const id = await cardOnWork(flow.body.id);
    const res = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'done' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storage.getItem(id) as any).status).toBe('REVIEW');
    expect(res.body.message).toContain('⚠️');
    expect(res.body.message).toMatch(/REVIEW asks for an independent review that this flow does not check/);
    expect(res.body.message).toMatch(/role 'review'/);
  });

  it("points a hub-delivered flow's warning at a hub admin", async () => {
    const flowId = uuidv4();
    await storage.createFlow({ id: flowId, name: `fcw-hub-${++seq}`, description: '', version: '1.0.0', steps: UNCHECKED(), createdAt: new Date(), updatedAt: new Date(), source: 'hub' } as any);
    const id = await cardOnWork(flowId);
    const res = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'done' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/hub admin/);
  });

  it('says nothing on entering a step that carries what it asks for', async () => {
    const steps = UNCHECKED().map(x => (x.name === 'REVIEW' ? { ...x, role: 'review' } : x));
    const flow = await agent().post('/flows').send({ name: `fcw-${++seq}`, steps });
    const id = await cardOnWork(flow.body.id);
    const res = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'done' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).not.toMatch(/does not check/);
  });
});
