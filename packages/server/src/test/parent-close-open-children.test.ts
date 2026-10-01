/**
 * 8024f6c4: BUG 759b606c reached DONE with two of its children still in TODO -
 * its close accepted while the work it stood for did not exist. The parent
 * roll-up (syncParentStatus) mirrors the LEAST advanced child and is not the
 * cause; the close came from a verify on the parent itself, and nothing in
 * verify asked whether the card still had open children.
 *
 * A card's final move is now refused while a direct child is unfinished.
 * Finished: on the flow's last step, or trashed, archived, or parked as an
 * idea. Refused before any check or suite runs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const TEST_DB = path.resolve('./parent-close-open-children-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

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
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-parentclose-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function setupWith(steps: any[], extra: Record<string, unknown> = {}) {
  const f = await agent().post('/flows').send({ name: `pc-${++seq}`, steps });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `pc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo(), verifyCommand: 'true', ...extra } as never);
  return p.body.id as string;
}
async function follow(id: string): Promise<{ status: number; body: any }> {
  const r = await agent().post(`/items/${id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'ok', async: true });
  if (r.status !== 202) return { status: r.status, body: r.body };
  for (let i = 0; i < 800; i++) {
    const run = await agent().get(`/items/validate-runs/${r.body.runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (run.body.finishedAt) return { status: run.body.status === 'passed' ? 200 : 400, body: run.body };
    await new Promise(res => setTimeout(res, 25));
  }
  throw new Error('the run never finished');
}
async function setup() {
  const f = await agent().post('/flows').send({ name: `pc-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `pc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo(), verifyCommand: 'true' } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string) =>
  agent().post(`/items/${id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'ok' });

describe("a card's final move while it has open children", () => {
  it('is refused, naming the children still open - and the card stays put', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    const open = await card(pid, 'START', { parentId: parent });
    await card(pid, 'END', { parentId: parent });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.children.map((c: { id: string }) => c.id)).toEqual([open]);
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('goes through once every child is finished - closed, trashed, archived or parked as an idea', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    for (const status of ['END', 'TRASHED', 'ARCHIVED', 'IDEAS']) await card(pid, status, { parentId: parent });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect((await storage.getItem(parent))?.status).toBe('END');
  });

  it('does not hold up a card with no children at all', async () => {
    const pid = await setup();
    const id = await card(pid, 'WORK');
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect((await storage.getItem(id))?.status).toBe('END');
  });

  it('sees a child that appears while the close is running, and refuses at the write', async () => {
    const pid = await setupWith([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })], { verifyCommand: 'sleep 1' });
    const parent = await card(pid, 'WORK');
    const run = follow(parent);
    await new Promise(r => setTimeout(r, 300));
    await card(pid, 'START', { parentId: parent });
    const res = await run;
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('on a flow whose last step is ordinary work, only leaving THAT step closes - and a child on it is not finished', async () => {
    const pid = await setupWith([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2)]);
    // WORK -> CHECK ends nothing: an open child does not hold it.
    const walking = await card(pid, 'WORK');
    await card(pid, 'START', { parentId: walking });
    expect((await validate(walking)).body.error).toBeUndefined();
    // CHECK -> DONE closes: a child still working on CHECK holds it.
    const closing = await card(pid, 'CHECK');
    await card(pid, 'CHECK', { parentId: closing });
    expect((await validate(closing)).body.error).toBe('CHILDREN_OPEN');
  });

  it("judges a moved child by its own project's flow", async () => {
    const pid = await setup();
    const other = await setupWith([s('START', 0, { isAnchor: true }), s('WORK', 1), s('SHIPPED', 2, { isAnchor: true })]);
    const parent = await card(pid, 'WORK');
    // Finished where it now lives: SHIPPED ends its flow, whatever the parent's flow calls its end.
    await card(other, 'SHIPPED', { parentId: parent });
    expect((await validate(parent)).body.error).toBeUndefined();
  });

  it('does not let the parent roll-up close the parent over a paused child', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    await card(pid, 'END', { parentId: parent });
    const paused = await card(pid, 'PAUSED', { parentId: parent });
    // Any update to a child re-runs the roll-up.
    await agent().put(`/items/${paused}`).send({ title: 'still paused' });
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('holds the close for open work deeper down, under a child that is finished', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    const child = await card(pid, 'END', { parentId: parent });
    const grandchild = await card(pid, 'START', { parentId: child });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.children.map((c: { id: string }) => c.id)).toEqual([grandchild]);
  });
});
