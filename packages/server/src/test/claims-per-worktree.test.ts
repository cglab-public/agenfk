/**
 * @file aaa01834 — claims are per worktree, and a card does not reach DONE
 * leaving staged files nobody owns.
 *
 * Two decisions by the user (2026-09-25), on top of the claims mechanism
 * (819e7192):
 *  - Two cards collide only when they share a tree. Cards in different
 *    worktrees meet at worst as a merge conflict, never as a silent overwrite,
 *    so refusing across trees only blocks work.
 *  - The close commit takes only a card's claimed files. A file it changed,
 *    staged and forgot to claim was left in the tree after DONE with no owner
 *    (C1's flowContract.ts, this branch). The move that ends the flow is now
 *    refused while such a file exists, and a step that must commit refuses the
 *    same way.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./claims-per-worktree-test-db.sqlite');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-claims-tree-'));
  dirs.push(dir);
  sh('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', dir);
  return dir;
}
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

async function project(plan: Record<string, unknown> = {}, work: Record<string, unknown> = {}) {
  const f = await agent().post('/flows').send({ name: `ct-${++seq}`, steps: [s('TODO', 0, { isAnchor: true }), s('PLAN', 1, plan), s('WORK', 2, work), s('DONE', 3, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = repo();
  const p = await agent().post('/projects').send({ name: `ct-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return { projectId: p.body.id as string, dir };
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const claim = (id: string, claims: string[]) => agent().put(`/items/${id}`).send({ claims });
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const statusOf = async (id: string) => (await agent().get(`/items/${id}`)).body.status;

describe('PUT claims: only cards in the same tree collide', () => {
  it('two cards in different worktrees may both claim a file', async () => {
    const { projectId } = await project();
    const a = await card(projectId, 'WORK', { worktreePath: '/wt/feat-a' });
    const b = await card(projectId, 'WORK', { worktreePath: '/wt/feat-b' });
    expect((await claim(a, ['packages/server/'])).status).toBe(200);
    const res = await claim(b, ['packages/server/src/server.ts']);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("a child resolves to its parent's worktree", async () => {
    const { projectId } = await project();
    const epic = await card(projectId, 'WORK', { worktreePath: '/wt/feat-a' });
    const child = await card(projectId, 'WORK', { parentId: epic });
    const other = await card(projectId, 'WORK', { worktreePath: '/wt/feat-a' });
    expect((await claim(other, ['x.ts'])).status).toBe(200);
    // Same tree through the parent: refused.
    expect((await claim(child, ['x.ts'])).status).toBe(409);
  });

  it('a PUT that re-parents and claims at once is judged in the tree it moves to', async () => {
    const { projectId } = await project();
    const epic = await card(projectId, 'WORK', { worktreePath: '/wt/feat-a' });
    const holder = await card(projectId, 'WORK', { worktreePath: '/wt/feat-a' });
    const mover = await card(projectId, 'WORK', { worktreePath: undefined });
    expect((await claim(holder, ['x.ts'])).status).toBe(200);
    // At the root it would be free (/wt/feat-a is another tree); under the epic it is not.
    const res = await agent().put(`/items/${mover}`).send({ parentId: epic, claims: ['x.ts'] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  it('two cards at the project root still collide, naming the holder', async () => {
    const { projectId } = await project();
    const a = await card(projectId, 'WORK');
    const b = await card(projectId, 'WORK');
    expect((await claim(a, ['x.ts'])).status).toBe(200);
    const res = await claim(b, ['x.ts']);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(a);
  });
});

describe('the move that ends the flow refuses stray staged files', () => {
  it('refuses DONE while a staged file lies outside the card\'s claims, and says how to fix it', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'stray.txt'), 's');
    sh('git add mine.txt stray.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    // The stray list names only the stray; the suggested --claims keeps the card's own claim.
    expect(res.body.message).toMatch(/in this worktree: `stray\.txt`\./);
    expect(res.body.message).toContain('--claims "mine.txt,stray.txt"');
    expect(res.body.message).toMatch(/unstage/i);
    expect(await statusOf(id)).toBe('WORK');
    // Nothing touched: the work is still staged.
    expect(sh('git diff --cached --name-only', dir).split('\n').sort()).toEqual(['mine.txt', 'stray.txt']);
  });

  it("refuses before the step's own checks run, not after them", async () => {
    // A TDD flow's checks can run a whole suite; a stray must not cost one.
    const marker = '/tmp/agenfk-claims-tree-check-ran-' + process.pid + '-' + Date.now();
    const { projectId, dir } = await project({}, { checks: [{ id: 'command-check', params: { name: 'probe', argv: ['touch', marker] } }] });
    const id = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'stray.txt'), 's'); sh('git add stray.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toContain('stray.txt');
    expect(fs.existsSync(marker), 'the step check ran before the refusal').toBe(false);
  });

  it('asks again just before the move: a file staged WHILE the suite ran is caught', async () => {
    const { projectId, dir } = await project();
    await storage.updateProject(projectId, { verifyCommand: 'echo s > late.txt && git add late.txt' } as never);
    const id = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); sh('git add mine.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toContain('late.txt');
    expect(await statusOf(id)).toBe('WORK');
  });

  it('a working card in the same tree that claims nothing may own the stray: a note, not a refusal', async () => {
    // Both remedies a refusal offers would take that card's work from it:
    // claiming the file commits it under this card, unstaging undoes its add.
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    const claimless = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    sh('git add mine.txt b.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toContain('b.txt');
    expect(res.body.message).toContain(claimless.slice(0, 8));
    expect(await statusOf(id)).toBe('DONE');
  });

  it('an unstarted claimless card is not a possible owner: still refused', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    await card(projectId, 'TODO');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'stray.txt'), 's'); sh('git add stray.txt', dir);
    expect((await validate(id)).status).toBe(422);
  });

  it("sees a rename's source: git mv into the claim leaves the old path's deletion unclaimed", async () => {
    const { projectId, dir } = await project();
    fs.mkdirSync(path.join(dir, 'old')); fs.writeFileSync(path.join(dir, 'old', 'x.ts'), 'export const x = 1;\n');
    sh('git add old && git commit -qm old', dir);
    const id = await card(projectId, 'WORK');
    expect((await claim(id, ['new/'])).status).toBe(200);
    fs.mkdirSync(path.join(dir, 'new')); sh('git mv old/x.ts new/x.ts', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toContain('old/x.ts');
  });

  it('refuses before running the suite, not after it', async () => {
    const { projectId, dir } = await project();
    const marker = path.join(dir, 'ran');
    await storage.updateProject(projectId, { verifyCommand: `touch ${JSON.stringify(marker)}` } as never);
    const id = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'stray.txt'), 's'); sh('git add stray.txt', dir);
    expect((await validate(id)).status).toBe(422);
    expect(fs.existsSync(marker), 'the suite ran before the refusal').toBe(false);
  });

  it('a staged file another active card in the same tree claims is theirs, and does not block', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    const other = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    expect((await claim(other, ['theirs.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'theirs.txt'), 't');
    sh('git add mine.txt theirs.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('DONE');
  });

  it('a claim held in ANOTHER worktree does not excuse a file staged in this one', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    const elsewhere = await card(projectId, 'WORK', { worktreePath: '/wt/elsewhere' });
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    expect((await claim(elsewhere, ['stray.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'stray.txt'), 's');
    sh('git add mine.txt stray.txt', dir);
    expect((await validate(id)).status).toBe(422);
  });

  it('a card that claims nothing is unaffected: its commit takes everything staged', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    fs.writeFileSync(path.join(dir, 'any.txt'), 'x'); sh('git add any.txt', dir);
    expect((await validate(id)).status).toBe(200);
  });

  it('unstaged, unclaimed changes do not block', async () => {
    const { projectId, dir } = await project();
    const id = await card(projectId, 'WORK');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); sh('git add mine.txt', dir);
    fs.writeFileSync(path.join(dir, 'loose.txt'), 'l');
    expect((await validate(id)).status).toBe(200);
  });
});

describe('a step that commits on leave, with stray staged files', () => {
  it('requireCommit: refuses to leave, listing the stray files', async () => {
    const { projectId, dir } = await project({ autoCommit: true, requireCommit: true });
    const id = await card(projectId, 'PLAN');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'stray.txt'), 's');
    sh('git add mine.txt stray.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toContain('stray.txt');
    expect(await statusOf(id)).toBe('PLAN');
    expect(sh('git log --format=%s', dir)).not.toMatch(/step\(/);
  });

  it('autoCommit only: commits the claimed files, moves on, and names the stray ones', async () => {
    const { projectId, dir } = await project({ autoCommit: true });
    const id = await card(projectId, 'PLAN');
    expect((await claim(id, ['mine.txt'])).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'stray.txt'), 's');
    sh('git add mine.txt stray.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sh('git show --name-only --format= HEAD', dir)).toBe('mine.txt');
    expect(res.body.message).toContain('stray.txt');
    expect(await statusOf(id)).toBe('WORK');
  });
});
