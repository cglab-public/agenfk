/**
 * @file 686fdbf6 — a card chooses the tree it runs in.
 *
 * A card runs in its own worktree, else its nearest ancestor's, else the
 * project root. An agent wanted a card in the main checkout while its epic's
 * worktree bound it - and detached the card from the epic, the only lever it
 * found. `worktree` on the card is the lever: a checkout path of the project's
 * own repository, `none` (the project root, whatever the parents have), or
 * `inherit` (the default: no choice of its own).
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

const TEST_DB = path.resolve('./card-worktree-choice-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim();

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A repository (the project root), two worktrees of it, and an unrelated clone; an epic working in the first worktree. */
async function setup() {
  const base = tmp('agenfk-wtc-');
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  sh(root, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
  const wt = path.join(base, 'wt');
  const wt2 = path.join(base, 'wt2');
  sh(root, `git worktree add -q -b feat/epic ${wt} && git worktree add -q -b feat/other ${wt2}`);
  const clone = path.join(base, 'clone');
  sh(base, `git clone -q ${root} ${clone}`);
  const f = await agent().post('/flows').send({ name: `wtc-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `wtc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: root, verifyCommand: 'true' } as never);
  const epic = await agent().post('/items').send({ type: 'EPIC', title: `wtc-epic-${++seq}`, projectId: p.body.id });
  await storage.updateItem(epic.body.id, { status: 'WORK', worktreePath: wt } as any);
  const child = await agent().post('/items').send({ type: 'TASK', title: `wtc-child-${++seq}`, projectId: p.body.id, parentId: epic.body.id });
  await storage.updateItem(child.body.id, { status: 'WORK' } as any);
  return { root, wt, wt2, clone, pid: p.body.id as string, epic: epic.body.id as string, child: child.body.id as string };
}
const put = (id: string, body: Record<string, unknown>) => agent().put(`/items/${id}`).send(body);
const verifyFrom = (id: string, cwd: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', cwd });
const tree = (res: any) => String(res.body?.testedRoot ?? '');

describe('686fdbf6: a card chooses the tree it runs in', () => {
  it("by default a child runs in its epic's worktree: a verify from the project root is refused, naming that worktree", async () => {
    const t = await setup();
    const res = await verifyFrom(t.child, t.root);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(tree(res)).toBe(t.wt);
  });

  it("'none' puts the card in the project root, whatever its parent's worktree", async () => {
    const t = await setup();
    const u = await put(t.child, { worktree: 'none' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const fromWt = await verifyFrom(t.child, t.wt);
    expect(fromWt.status).toBe(409);
    expect(tree(fromWt)).toBe(t.root);
    expect((await verifyFrom(t.child, t.root)).status).toBe(200);
  });

  it("'none' on a parent covers its children too", async () => {
    const t = await setup();
    expect((await put(t.epic, { worktree: 'none' })).status).toBe(200);
    expect((await verifyFrom(t.child, t.root)).status).toBe(200);
  });

  it('a path puts the card in that checkout of the same repository, stored as git lists it', async () => {
    const t = await setup();
    const u = await put(t.child, { worktree: t.wt2 + '/' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.worktreeChoice).toBe(t.wt2);
    // Never in worktreePath: that is the checkout agenfk made, which remove and prune may delete.
    expect(u.body.worktreePath).toBeUndefined();
    expect((await verifyFrom(t.child, t.wt)).status).toBe(409);
    expect((await verifyFrom(t.child, t.wt2)).status).toBe(200);
  });

  it('the main checkout can be chosen by path too', async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: t.root })).status).toBe(200);
    expect((await verifyFrom(t.child, t.root)).status).toBe(200);
  });

  it("a card that chose the root is verified there even though it carries agenfk's worktree", async () => {
    const t = await setup();
    expect((await put(t.epic, { worktree: 'none' })).status).toBe(200);
    expect((await verifyFrom(t.epic, t.wt)).status).toBe(409);
    expect((await verifyFrom(t.epic, t.root)).status).toBe(200);
  });

  it('removing the worktree of a card that chose a checkout leaves that checkout alone', async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: t.wt2 })).status).toBe(200);
    const del = await agent().delete(`/items/${t.child}/worktree`).set(internal());
    expect(del.body.removed).toBe(false);
    expect(fs.existsSync(t.wt2)).toBe(true);
  });

  it("the card's own tree panels show the tree it chose, and none for the project root", async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: t.wt2 })).status).toBe(200);
    expect((await agent().get(`/items/${t.child}/git-status`)).status).toBe(200);
    expect((await put(t.epic, { worktree: 'none' })).status).toBe(200);
    expect((await agent().get(`/items/${t.epic}/git-status`)).status).toBe(409);
  });

  it('creating a worktree for the card supersedes a tree it chose', async () => {
    const t = await setup();
    const top = await agent().post('/items').send({ type: 'TASK', title: `wtc-top-${++seq}`, projectId: t.pid });
    expect((await put(top.body.id, { worktree: 'none' })).status).toBe(200);
    const made = await agent().post(`/items/${top.body.id}/worktree`).set(internal()).send({});
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const after = await storage.getItem(top.body.id) as any;
    expect(after?.worktreePath).toBeTruthy();
    expect(after?.worktreeChoice).toBeUndefined();
    dirs.push(after.worktreePath);
  });

  it('a tree move is refused when a descendant that follows the card would collide there', async () => {
    const t = await setup();
    const other = await agent().post('/items').send({ type: 'TASK', title: `wtc-o-${++seq}`, projectId: t.pid });
    await storage.updateItem(other.body.id, { status: 'WORK', worktreeChoice: t.root } as any);
    expect((await put(other.body.id, { claims: ['lib/'] })).status).toBe(200);
    expect((await put(t.child, { claims: ['lib/'] })).status).toBe(200);
    const move = await put(t.epic, { worktree: t.root });
    expect(move.status, JSON.stringify(move.body)).toBe(409);
    expect(move.body.error).toContain(t.child);
    expect((await storage.getItem(t.epic) as any)?.worktreeChoice).toBeUndefined();
  });

  it("refuses to remove a card's worktree while another card chose to run in it", async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: t.wt })).status).toBe(200);
    const del = await agent().delete(`/items/${t.epic}/worktree`).set(internal());
    expect(del.status, JSON.stringify(del.body)).toBe(409);
    expect(del.body.error).toContain(t.child);
    expect(fs.existsSync(t.wt)).toBe(true);
  });

  it('a verify of a card whose chosen tree is gone says how to choose another', async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: t.wt2 })).status).toBe(200);
    fs.rmSync(t.wt2, { recursive: true, force: true });
    const res = await verifyFrom(t.child, t.root);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/--worktree inherit/);
  });

  it("the card's worktree record names the tree it chose", async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: t.wt2 })).status).toBe(200);
    expect((await agent().get(`/items/${t.child}/worktree`)).body.chosen).toBe(t.wt2);
  });

  it('a symlinked spelling is refused: the tree is what git lists, not a link to it', async () => {
    const t = await setup();
    const link = path.join(path.dirname(t.root), 'link-to-wt2');
    fs.symlinkSync(t.wt2, link);
    expect((await put(t.child, { worktree: link })).status).toBe(400);
  });

  it('choosing a tree is refused when a card there already holds the same files', async () => {
    const t = await setup();
    const other = await agent().post('/items').send({ type: 'TASK', title: `wtc-other-${++seq}`, projectId: t.pid });
    await storage.updateItem(other.body.id, { status: 'WORK', worktreeChoice: t.wt2 } as any);
    expect((await put(other.body.id, { claims: ['src/'] })).status).toBe(200);
    expect((await put(t.child, { claims: ['src/'] })).status).toBe(200);
    const move = await put(t.child, { worktree: t.wt2 });
    expect(move.status, JSON.stringify(move.body)).toBe(409);
    expect((await storage.getItem(t.child) as any)?.worktreeChoice).toBeUndefined();
  });

  it("'inherit' clears the choice: the card follows its parent again", async () => {
    const t = await setup();
    expect((await put(t.child, { worktree: 'none' })).status).toBe(200);
    expect((await put(t.child, { worktree: 'inherit' })).status).toBe(200);
    const res = await verifyFrom(t.child, t.root);
    expect(res.status).toBe(409);
    expect(tree(res)).toBe(t.wt);
  });

  it("'inherit' keeps a worktree agenfk created for the card, and clears only the choice", async () => {
    const t = await setup();
    expect((await put(t.epic, { worktree: t.wt2 })).status).toBe(200);
    expect((await put(t.epic, { worktree: 'inherit' })).status).toBe(200);
    const epic = await storage.getItem(t.epic) as any;
    expect(epic?.worktreePath).toBe(t.wt);
    expect(epic?.worktreeChoice).toBeUndefined();
    expect(tree(await verifyFrom(t.child, t.root))).toBe(t.wt);
  });

  it('refuses a path that does not exist, or that is not a checkout of the project\'s repository', async () => {
    const t = await setup();
    const missing = await put(t.child, { worktree: path.join(t.root, 'nope') });
    expect(missing.status).toBe(400);
    const other = await put(t.child, { worktree: t.clone });
    expect(other.status).toBe(400);
    expect(other.body.error).toMatch(/not a checkout of this project's repository/);
    const junk = await put(t.child, { worktree: 42 });
    expect(junk.status).toBe(400);
    // Nothing was stored: the card still follows its epic.
    expect(tree(await verifyFrom(t.child, t.root))).toBe(t.wt);
  });

  it('the refusal from the wrong tree names the way to choose one', async () => {
    const t = await setup();
    const res = await verifyFrom(t.child, t.root);
    expect(res.body.error).toMatch(/agenfk update <id> --worktree/);
  });
});
