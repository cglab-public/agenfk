/**
 * @file 281adef0 — a flow can run the project's suite once, at the top-level
 * card, instead of at every card's final step.
 *
 * Why: sibling propagation only skips a run when the tree is clean at the very
 * commit a sibling's green was recorded at, and every close commit moves HEAD -
 * so S2..S5 of a story each paid a full run, and the parent ran it again.
 *
 * The safeguard that must not move: the top-level card ALWAYS runs it, and a
 * child whose parent is already finished runs its own, so nothing lands
 * unverified.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('verify-at-parent-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { posixShell } from './helpers/posixShell';
import { nodeCommand } from './helpers/nodeCommand';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
const STEPS = [s('TODO', 0, { isAnchor: true }), s('WORK', 1), s('DONE', 2, { isAnchor: true })];

/**
 * A project whose verifyCommand leaves a marker per run (after `delayMs`), on a flow with `verifyAt`.
 * In node, not `touch "<dir>/run"-$$`: cmd.exe has no touch or sleep (they only resolved
 * through Git Bash's /usr/bin on PATH) and does not expand `$$`, so on Windows every run
 * wrote the same file and "ran exactly once" could not fail (#208 branch review).
 */
async function project(verifyAt?: string, { command = true, steps = STEPS, delayMs = 0, flowExtra = {}, projectExtra = {} }: { command?: boolean; steps?: unknown[]; delayMs?: number; flowExtra?: Record<string, unknown>; projectExtra?: Record<string, unknown> } = {}) {
  const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps, ...(verifyAt ? { verifyAt } : {}), ...flowExtra });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-vap-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  const runs = path.join(dir, '..', `${path.basename(dir)}-runs`);
  dirs.push(runs);
  fs.mkdirSync(runs);
  const p = await agent().post('/projects').send({ name: `vap-${++seq}` });
  const mark = `require('fs').writeFileSync(require('path').join(${JSON.stringify(runs)}, 'run-' + process.pid + '-' + Date.now()), '')`;
  const verifyCommand = nodeCommand(delayMs ? `setTimeout(() => { ${mark}; }, ${delayMs});` : `${mark};`);
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, ...(command ? { verifyCommand } : {}), ...projectExtra } as never);
  return { pid: p.body.id as string, runCount: () => fs.readdirSync(runs).length, flowId: f.body.id as string, dir };
}
async function card(projectId: string, status = 'WORK', extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId, ...extra });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const get = async (id: string) => (await agent().get(`/items/${id}?records=1`)).body;

describe('the verifyAt flow setting', () => {
  it('is stored on POST and changed on PUT', async () => {
    const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps: STEPS, verifyAt: 'parent' });
    expect(f.status).toBe(201);
    expect(f.body.verifyAt).toBe('parent');
    const u = await agent().put(`/flows/${f.body.id}`).send({ verifyAt: 'leaf' });
    expect(u.status).toBe(200);
    expect(u.body.verifyAt).toBe('leaf');
  });

  it('a rename-only PUT keeps it', async () => {
    const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps: STEPS, verifyAt: 'parent' });
    const u = await agent().put(`/flows/${f.body.id}`).send({ name: `renamed-${seq}` });
    expect(u.body.verifyAt).toBe('parent');
  });

  it('refuses a value it does not know', async () => {
    const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps: STEPS, verifyAt: 'top' });
    expect(f.status).toBe(400);
    expect(f.body.error).toMatch(/'leaf' or 'parent'/);
  });
});

describe("verifyAt: 'parent'", () => {
  it('a card with an open parent closes WITHOUT running the suite, saying where it went', async () => {
    const { pid, runCount } = await project('parent');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await get(child)).status).toBe('DONE');
    expect(runCount(), 'the suite ran for a child').toBe(0);
    expect(res.body.message).toContain(parent.slice(0, 8));
    // No green it did not earn.
    expect(((await get(child)).tests ?? []).filter((t: any) => t.status === 'PASSED')).toHaveLength(0);
  });

  it('the roll-up never walks the parent onto its exit step: its own verify runs the suite (281adef0 review)', async () => {
    const { pid, runCount } = await project('parent');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect((await get(parent)).status, 'the parent was closed with the suite run nowhere').toBe('WORK');
    expect(runCount()).toBe(0);
    expect((await validate(parent)).status).toBe(200);
    expect((await get(parent)).status).toBe('DONE');
    expect(runCount()).toBe(1);
  });

  it('a parent in another project is not deferred to: the child runs its own project\'s suite', async () => {
    const a = await project('parent');
    const b = await project('parent');
    const parent = await card(a.pid);
    // As /items/:id/move leaves it: the moved card keeps its parentId into the old project.
    const child = await card(b.pid);
    await storage.updateItem(child, { parentId: parent } as any);
    expect((await validate(child)).status).toBe(200);
    expect(b.runCount()).toBe(1);
  });

  it('a mid-flow boundary step still runs its command: only the move that ends the flow defers', async () => {
    const steps = [s('TODO', 0, { isAnchor: true }), s('WORK', 1), s('HOLD', 2, { isSpecial: true }), s('NEXT', 3), s('DONE', 4, { isAnchor: true })];
    const { pid, runCount } = await project('parent', { steps });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(runCount()).toBe(1);
    expect(res.body.message).not.toMatch(/deferred/);
  });

  it('checks the suite would settle say they were deferred to the parent, and need no verifyCommand (281adef0 review)', async () => {
    const steps = [s('TODO', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('DONE', 2, { isAnchor: true })];
    const { pid } = await project('parent', { steps, command: false });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const exit = (await get(child)).stepRecords.find((r: any) => r.kind === 'exit' && r.step === 'WORK');
    const green = exit.checks.find((c: any) => c.id === 'suite-green');
    expect(green.outcome).toBe('deferred');
    expect(green.detail).toMatch(/not run on this card/);
    expect(green.detail).not.toMatch(/enforced on this transition/);
  });

  it("a child does not defer to a parent whose own verify is running: that run may not see the child's work", async () => {
    const { pid } = await project('parent', { delayMs: 1000 });
    const parent = await card(pid);
    // The parent's close starts only with its children finished (8024f6c4), so the child this
    // guards is one that appears while that run is going - and must not lean on it.
    const started = await agent().post(`/items/${parent}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok', async: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const child = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).not.toMatch(/deferred/);
    expect(((await get(child)).tests ?? []).some((t: any) => t.status === 'PASSED')).toBe(true);
    // Let the parent's run finish before the next test.
    for (let i = 0; i < 50 && (await get(parent)).status !== 'DONE'; i++) await new Promise(r => setTimeout(r, 100));
  });

  it('the top-level card still runs it', async () => {
    const { pid, runCount } = await project('parent');
    const top = await card(pid);
    expect((await validate(top)).status).toBe(200);
    expect(runCount()).toBe(1);
  });

  it('a child whose parent is already finished runs its own: nobody else would', async () => {
    const { pid, runCount } = await project('parent');
    const parent = await card(pid, 'DONE');
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(runCount()).toBe(1);
  });

});

describe("verifyAt: 'leaf' (the default)", () => {
  it('a child runs the suite, as it always has', async () => {
    const { pid, runCount } = await project();
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(runCount()).toBe(1);
  });
});

describe("verifyAt: 'parent' - round-2 review (281adef0)", () => {
  it("a child whose work is in ANOTHER worktree runs its own: the parent's verify tests the parent's tree", async () => {
    const { pid, dir, runCount } = await project('parent');
    const wt = `${dir}-wt`;
    dirs.push(wt);
    execSync(`git worktree add -q -b child-branch ${JSON.stringify(wt)}`, { cwd: dir });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).not.toMatch(/deferred/);
    expect(runCount()).toBe(1);
  });

  it('a paused parent is not deferred to: it may never come back to run it', async () => {
    const { pid, runCount } = await project('parent');
    const parent = await card(pid, 'PAUSED');
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(runCount()).toBe(1);
  });

  it("turning 'parent' off afterwards does not let the owed run slip: the roll-up still stops short", async () => {
    const { pid, flowId, runCount } = await project('parent');
    const parent = await card(pid);
    const done = await card(pid, 'WORK', { parentId: parent });
    const open = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(done)).status).toBe(200);
    await agent().put(`/flows/${flowId}`).send({ verifyAt: 'leaf' });
    // Anything that re-runs the roll-up: here the open sibling is trashed.
    await agent().put(`/items/${open}`).send({ status: 'TRASHED' });
    expect((await get(parent)).status, 'the parent closed with the owed run never made').not.toBe('DONE');
    expect(runCount()).toBe(0);
  });

  it('the stop applies only onto the step that ends the flow: on special-bounded flows the parent is not held back', async () => {
    const steps = [s('START', 0, { isSpecial: true, isAnchor: true }), s('WORK', 1), s('CHECK', 2), s('END', 3, { isSpecial: true, isAnchor: true })];
    const { pid } = await project('parent', { steps });
    const parent = await card(pid, 'WORK');
    // WORK -> CHECK does not end the flow: CHECK is the last POSITIONED step, not the end.
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect((await get(child)).status).toBe('CHECK');
    expect((await get(parent)).status).toBe('CHECK');
  });
});

/*
 * 7ddeaf7c — verifyAtScope: how far 'parent' reaches. Under 'worktree' (the
 * default, the behaviour above) a child defers only to a parent in its own
 * tree. Under 'project' a child in ANOTHER worktree defers too - and since the
 * parent's verify tests the parent's tree, that verify is refused until the
 * child's work has been merged into it. Nothing lands untested either way.
 */
describe('verifyAtScope', () => {
  /** A worktree of the project's repo on its own branch, with one commit of the child's work in it. */
  function childWorktree(dir: string, branch: string) {
    const wt = `${dir}-${branch}`;
    dirs.push(wt);
    execSync(`git worktree add -q -b ${branch} ${JSON.stringify(wt)}`, { cwd: dir });
    execSync('echo work > child.txt && git add child.txt && git commit -qm "child work"', { cwd: wt, shell: posixShell() });
    return wt;
  }
  const plan = async (id: string) => (await agent().get(`/items/${id}/leave-plan`)).body;

  it('is stored on POST and changed on PUT, and a PUT that does not name it keeps it', async () => {
    const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps: STEPS, verifyAt: 'parent', verifyAtScope: 'project' });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect(f.body.verifyAtScope).toBe('project');
    const kept = await agent().put(`/flows/${f.body.id}`).send({ name: `renamed-${++seq}` });
    expect(kept.body.verifyAtScope).toBe('project');
    const u = await agent().put(`/flows/${f.body.id}`).send({ verifyAtScope: 'worktree' });
    expect(u.status).toBe(200);
    expect(u.body.verifyAtScope).toBe('worktree');
  });

  it('refuses a scope it does not know', async () => {
    const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps: STEPS, verifyAt: 'parent', verifyAtScope: 'repo' });
    expect(f.status).toBe(400);
    expect(f.body.error).toMatch(/'worktree' or 'project'/);
  });

  it("'project': a child in another worktree closes WITHOUT running the suite, deferred to its parent", async () => {
    const { pid, dir, runCount } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-a');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await get(child)).status).toBe('DONE');
    expect(res.body.message).toMatch(/deferred/);
    expect(res.body.message).toContain(parent.slice(0, 8));
    expect(runCount(), 'the suite ran for a child').toBe(0);
  });

  it("'project': the parent's verify is REFUSED while the child's work is not merged into its tree, naming the child and its branch", async () => {
    const { pid, dir, runCount } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-b');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    const refused = await validate(parent);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toBe('DEFERRED_CHILD_UNMERGED');
    expect(refused.body.message).toContain(child.slice(0, 8));
    expect(refused.body.message).toContain('scope-b');
    expect((await get(parent)).status).toBe('WORK');
    expect(runCount(), 'the suite ran over a tree without the child in it').toBe(0);
    // Merged: the one run covers it.
    execSync('git merge -q --no-edit scope-b', { cwd: dir });
    const ok = await validate(parent);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await get(parent)).status).toBe('DONE');
    expect(runCount()).toBe(1);
  });

  it("'project': a merge taken before the child's last commit does not count - the check is on the commit the child closed on", async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-c');
    execSync('git merge -q --no-edit scope-c', { cwd: dir });
    // Merged BEFORE the child's last commit, which is the one it closes on.
    execSync('echo more > more.txt && git add more.txt && git commit -qm "more child work"', { cwd: wt, shell: posixShell() });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    expect((await validate(parent)).status).toBe(422);
  });

  it('the leave plan says the parent\'s verify will refuse until the child is merged', async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-d');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    const p = await plan(parent);
    expect(p.refuses).toBe('DEFERRED_CHILD_UNMERGED');
    expect(p.advice).toContain(child.slice(0, 8));
    expect(p.advice).toContain('scope-d');
  });

  // Review of 7ddeaf7c (Codex #1): the parent's run sees only what the child COMMITS.
  it("'project': a child with unstaged or untracked work is refused - the close commit would leave it out - and nothing moves", async () => {
    const { pid, dir, runCount } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-h');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    fs.writeFileSync(path.join(wt, 'child.txt'), 'changed, not staged');
    const unstaged = await validate(child);
    expect(unstaged.status, JSON.stringify(unstaged.body)).toBe(422);
    expect(unstaged.body.error).toBe('DEFERRED_CLOSE_UNCOMMITTED');
    expect(unstaged.body.message).toContain('child.txt');
    expect((await get(child)).status).toBe('WORK');
    execSync('git checkout -- child.txt', { cwd: wt });
    fs.writeFileSync(path.join(wt, 'new.txt'), 'untracked');
    const untracked = await validate(child);
    expect(untracked.status).toBe(422);
    expect(untracked.body.message).toContain('new.txt');
    // Staged, it goes into the close commit: the close goes through.
    execSync('git add new.txt', { cwd: wt });
    expect((await validate(child)).status).toBe(200);
    expect(runCount()).toBe(0);
  });

  // Review of 7ddeaf7c, second pass: git config must not hide untracked work from the refusal.
  it("'project': an untracked file is seen even with status.showUntrackedFiles=no", async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-j');
    execSync('git config status.showUntrackedFiles no', { cwd: dir });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    fs.writeFileSync(path.join(wt, 'hidden.txt'), 'untracked');
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toContain('hidden.txt');
  });

  // Review of 7ddeaf7c, second pass: a move to another project would take the child out of its parent's walk.
  it("'project': moving a child that owes a merge to another project is refused while its parent is open", async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const elsewhere = await project('parent');
    const wt = childWorktree(dir, 'scope-k');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    const moved = await agent().post(`/items/${child}/move`).send({ targetProjectId: elsewhere.pid });
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);
    expect(moved.body.error).toBe('DEFERRED_OBLIGATION_OPEN');
    expect((await validate(parent)).status).toBe(422);
    // Moved together with its parent, the obligation travels with them.
    expect((await agent().post(`/items/${parent}/move`).send({ targetProjectId: elsewhere.pid })).status).toBe(200);
  });

  // Review of 7ddeaf7c, third pass: a parent that passed the run on to ITS parent settled nothing.
  it("'project': moving a child is refused while the run it deferred was passed on up and not run yet", async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const elsewhere = await project('parent');
    const wt = childWorktree(dir, 'scope-l');
    const top = await card(pid);
    const mid = await card(pid, 'WORK', { parentId: top });
    const child = await card(pid, 'WORK', { parentId: mid });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    // mid shares top's tree: it closes by deferring again, running nothing.
    execSync('git merge -q --no-edit scope-l', { cwd: dir });
    const midClose = await validate(mid);
    expect(midClose.status, JSON.stringify(midClose.body)).toBe(200);
    expect(midClose.body.message).toMatch(/deferred/);
    const moved = await agent().post(`/items/${child}/move`).send({ targetProjectId: elsewhere.pid });
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);
    expect(moved.body.message).toContain(top.slice(0, 8));
  });

  // Review of 7ddeaf7c, fourth pass: archiving the parent ran nothing - and it may be restored.
  it("'project': an archived parent has not settled the merge: the child still may not move away", async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const elsewhere = await project('parent');
    const wt = childWorktree(dir, 'scope-n');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    await storage.updateItem(parent, { status: 'ARCHIVED' } as any);
    expect((await agent().post(`/items/${child}/move`).send({ targetProjectId: elsewhere.pid })).status).toBe(409);
  });

  it("'project': once the card that runs the suite has run it, on a flow whose last step is not called DONE, the child may move", async () => {
    const steps = [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })];
    const { pid, dir } = await project('parent', { steps, flowExtra: { verifyAtScope: 'project' } });
    const elsewhere = await project('parent');
    const wt = childWorktree(dir, 'scope-m');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    execSync('git merge -q --no-edit scope-m', { cwd: dir });
    expect((await validate(parent)).status).toBe(200);
    expect((await get(parent)).status).toBe('END');
    expect((await agent().post(`/items/${child}/move`).send({ targetProjectId: elsewhere.pid })).status).toBe(200);
  });

  // Review of 7ddeaf7c (Codex #3): the obligation follows whom the child deferred TO, not its parent now.
  it("'project': moving the child under another parent after it deferred does not drop the merge its first parent owes", async () => {
    const { pid, dir } = await project('parent', { flowExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-i');
    const parent = await card(pid);
    const other = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    await storage.updateItem(child, { parentId: other } as any);
    const refused = await validate(parent);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.message).toContain(child.slice(0, 8));
  });

  // 'worktree' (the default) keeps a worktree child running its own: "a child whose work is in ANOTHER worktree runs its own",
  // and set explicitly on the project, "...and 'worktree' on the project keeps a worktree child running its own on a 'project' flow".
  it("the project's own scope wins over the flow's: 'project' on the project defers a worktree child on a 'worktree' flow", async () => {
    const { pid, dir, runCount } = await project('parent', { projectExtra: { verifyAtScope: 'project' } });
    const wt = childWorktree(dir, 'scope-f');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/deferred/);
    expect(runCount()).toBe(0);
  });

  it("...and 'worktree' on the project keeps a worktree child running its own on a 'project' flow", async () => {
    const { pid, dir, runCount } = await project('parent', { flowExtra: { verifyAtScope: 'project' }, projectExtra: { verifyAtScope: 'worktree' } });
    const wt = childWorktree(dir, 'scope-g');
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    await storage.updateItem(child, { worktreePath: wt } as any);
    expect((await validate(child)).status).toBe(200);
    expect(runCount()).toBe(1);
  });

  it("scope means nothing under verifyAt 'leaf': a child runs its own", async () => {
    const { pid, runCount } = await project(undefined, { flowExtra: { verifyAtScope: 'project' } });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(runCount()).toBe(1);
  });
});

describe('project settings: verifyAtScope and exclusiveSuite through PUT /projects/:id', () => {
  it('stores both, clears the scope with null, and reads them back', async () => {
    const p = await agent().post('/projects').send({ name: `vap-${++seq}` });
    const u = await agent().put(`/projects/${p.body.id}`).send({ verifyAtScope: 'project', exclusiveSuite: true });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    let got = (await agent().get(`/projects/${p.body.id}`)).body;
    expect(got.verifyAtScope).toBe('project');
    expect(got.exclusiveSuite).toBe(true);
    expect((await agent().put(`/projects/${p.body.id}`).send({ verifyAtScope: null, exclusiveSuite: false })).status).toBe(200);
    got = (await agent().get(`/projects/${p.body.id}`)).body;
    expect(got.verifyAtScope ?? null).toBeNull();
    expect(got.exclusiveSuite).toBe(false);
  });

  it('refuses values it does not know', async () => {
    const p = await agent().post('/projects').send({ name: `vap-${++seq}` });
    const bad = await agent().put(`/projects/${p.body.id}`).send({ verifyAtScope: 'repo' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/'worktree' or 'project'/);
    expect((await agent().put(`/projects/${p.body.id}`).send({ exclusiveSuite: 'yes' })).status).toBe(400);
  });
});
