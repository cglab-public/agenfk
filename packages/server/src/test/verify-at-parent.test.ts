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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./verify-at-parent-test-db.sqlite');
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

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
const STEPS = [s('TODO', 0, { isAnchor: true }), s('WORK', 1), s('DONE', 2, { isAnchor: true })];

/** A project whose verifyCommand leaves a marker per run, on a flow with `verifyAt`. */
async function project(verifyAt?: string, { command = true, steps = STEPS, cmd }: { command?: boolean; steps?: unknown[]; cmd?: (marker: string) => string } = {}) {
  const f = await agent().post('/flows').send({ name: `vap-${++seq}`, steps, ...(verifyAt ? { verifyAt } : {}) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-vap-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const runs = path.join(dir, '..', `${path.basename(dir)}-runs`);
  dirs.push(runs);
  fs.mkdirSync(runs);
  const p = await agent().post('/projects').send({ name: `vap-${++seq}` });
  const marker = `${JSON.stringify(path.join(runs, 'run'))}-$$`;
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, ...(command ? { verifyCommand: cmd ? cmd(marker) : `touch ${marker}` } : {}) } as never);
  return { pid: p.body.id as string, runCount: () => fs.readdirSync(runs).length, flowId: f.body.id as string, dir };
}
async function card(projectId: string, status = 'WORK', extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId, ...extra });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const get = async (id: string) => (await agent().get(`/items/${id}`)).body;

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
    const { pid } = await project('parent', { cmd: marker => `sleep 1 && touch ${marker}` });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    const started = await agent().post(`/items/${parent}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok', async: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
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

  it('a deferred child does not need a verifyCommand of its own', async () => {
    const { pid } = await project('parent', { command: false });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
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

describe("verifyAt: 'parent' on the background path (281adef0 review)", () => {
  it('a deferred close from a background step gate still refuses ownerless staged files', async () => {
    // A command check makes the gate slow, so it runs in the background and re-enters verify with its result.
    // The check itself stages the stray, so it lands AFTER the early check and only the re-entry can catch it.
    const stage = "require('fs').writeFileSync('stray.txt','s');require('child_process').execSync('git add stray.txt')";
    const steps = [s('TODO', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'command-check', params: { name: 'ok', argv: [process.execPath, '-e', stage] } }] }), s('DONE', 2, { isAnchor: true })];
    const { pid, dir } = await project('parent', { steps });
    const parent = await card(pid);
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await agent().put(`/items/${child}`).send({ claims: ['mine.txt'] })).status).toBe(200);
    // A working parent that claims nothing might own the stray (a note, not a refusal): give it claims.
    expect((await agent().put(`/items/${parent}`).send({ claims: ['parent.txt'] })).status).toBe(200);
    const started = await agent().post(`/items/${child}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok', async: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let final: any = started.body;
    if (started.status === 202) {
      for (let i = 0; i < 100; i++) {
        final = (await agent().get(`/items/validate-runs/${started.body.runId}`).set({ 'x-agenfk-internal': VERIFY_TOKEN! })).body;
        if (final.status && final.status !== 'running') break;
        await new Promise(r => setTimeout(r, 50));
      }
    }
    expect(JSON.stringify(final)).toContain('stray.txt');
    expect((await get(child)).status).toBe('WORK');
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
