/**
 * @file 26c059f6 — claims are gone.
 *
 * The claims mechanism (819e7192, scoped per worktree in aaa01834) made a card
 * declare the paths it owned, refused another card's edits and staged files
 * inside them, and limited the close and step commits to them. In practice it
 * locked parallel work: two agents could not change different regions of one
 * file, which a person does every day, and the refusals fired on the work they
 * were meant to protect. It was removed at the user's and Daniel's request.
 *
 * What replaces it is what existed before it: staging is the agent's own job,
 * and a commit takes what was staged. A `claims` field still arriving from an
 * agent on old rules is ignored, and one stored on an old card changes nothing.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('claims-removed-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-claims-gone-'));
  dirs.push(dir);
  sh('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', dir);
  return dir;
}
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

async function project(plan: Record<string, unknown> = {}) {
  const f = await agent().post('/flows').send({ name: `cg-${++seq}`, steps: [s('TODO', 0, { isAnchor: true }), s('PLAN', 1, plan), s('WORK', 2), s('DONE', 3, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = repo();
  const p = await agent().post('/projects').send({ name: `cg-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return { projectId: p.body.id as string, dir };
}
/** A card, with `claims` written straight to storage the way an old card carries them. */
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const statusOf = async (id: string) => (await agent().get(`/items/${id}`)).body.status;

describe('declaring claims', () => {
  it('is accepted and ignored: nothing is stored', async () => {
    // An agent still on the old rules declares claims before its first edit.
    // Refusing would break it mid-task; storing would bring the mechanism back.
    const { projectId } = await project();
    const id = await card(projectId, 'WORK');
    const res = await agent().put(`/items/${id}`).send({ claims: ['packages/server/'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.claims ?? []).toEqual([]);
  });

  it('is never refused because another card holds the path', async () => {
    const { projectId } = await project();
    await card(projectId, 'WORK', { claims: ['packages/server/'] });
    const mine = await card(projectId, 'WORK');
    const res = await agent().put(`/items/${mine}`).send({ claims: ['packages/server/src/server.ts'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('closing a card with files staged outside an old claim', () => {
  it('is not refused', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK', { claims: ['mine.txt'] });
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'other.txt'), 'o');
    sh('git add mine.txt other.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message ?? '').not.toMatch(/claim/i);
    expect(await statusOf(id)).toBe('DONE');
  });
});

describe('a step that commits on leave', () => {
  it('commits everything staged, an old claim or not', async () => {
    const { projectId, dir } = await project({ autoCommit: true, requireCommit: true });
    const id = await card(projectId, 'PLAN', { claims: ['mine.txt'] });
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'other.txt'), 'o');
    sh('git add mine.txt other.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sh('git show --name-only --format= HEAD', dir).split('\n').sort()).toEqual(['mine.txt', 'other.txt']);
    expect(res.body.message ?? '').not.toMatch(/claim/i);
    expect(await statusOf(id)).toBe('WORK');
  });
});
