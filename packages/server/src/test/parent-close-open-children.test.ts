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
});
