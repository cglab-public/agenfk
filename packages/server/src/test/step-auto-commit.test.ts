/**
 * @file CGLAB-388 (S10) — a step with autoCommit commits the card's work as
 * the card leaves it: only what is staged, limited to the card's claims, with
 * `step(<STEP>): <title> [<id>]`, the sha on the exit record, and a reply that
 * says what happened. requireCommit turns a missing commit into a refusal.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./step-auto-commit-test-db.sqlite');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-step-commit-'));
  dirs.push(dir);
  sh('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', dir);
  return dir;
}
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function setup(plan: Record<string, unknown>, status = 'PLAN', work: Record<string, unknown> = {}) {
  const f = await agent().post('/flows').send({ name: `sc-${++seq}`, steps: [s('TODO', 0, { isAnchor: true }), s('PLAN', 1, plan), s('WORK', 2, work), s('DONE', 3, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = repo();
  const p = await agent().post('/projects').send({ name: `sc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return { id: c.body.id as string, dir, title: c.body.title as string };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
const exitOf = async (id: string, step: string) => (await item(id)).stepRecords.find((r: any) => r.kind === 'exit' && r.step === step);

describe('CGLAB-388: commit when the card leaves the step', () => {
  it("commits what is staged, with step(<STEP>), and records the sha", async () => {
    const { id, dir, title } = await setup({ autoCommit: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sh('git log -1 --format=%s', dir)).toBe(`step(PLAN): ${title} [${id}]`);
    expect((await exitOf(id, 'PLAN')).commit).toBe(sh('git rev-parse HEAD', dir));
    expect(res.body.message).toMatch(/step commit/i);
  });

  it("commits only the card's claimed files, leaving another card's staged work alone", async () => {
    const { id, dir } = await setup({ autoCommit: true });
    await agent().put(`/items/${id}`).send({ claims: ['mine.txt'] });
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'm'); fs.writeFileSync(path.join(dir, 'theirs.txt'), 't');
    sh('git add mine.txt theirs.txt', dir);
    expect((await validate(id)).status).toBe(200);
    expect(sh('git show --name-only --format= HEAD', dir)).toBe('mine.txt');
    expect(sh('git diff --cached --name-only', dir)).toBe('theirs.txt');
  });

  it('says so when nothing was staged, and still moves on', async () => {
    const { id, dir } = await setup({ autoCommit: true });
    fs.writeFileSync(path.join(dir, 'loose.txt'), 'l');
    const res = await validate(id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/nothing was staged/i);
    expect(res.body.message).toMatch(/loose\.txt/);
    expect(sh('git log --format=%s', dir)).not.toMatch(/step\(/);
  });

  it('reports a declined commit (a merge in progress)', async () => {
    const { id, dir } = await setup({ autoCommit: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), sh('git rev-parse HEAD', dir) + '\n');
    const res = await validate(id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/merge is in progress/i);
  });

  it('requireCommit: a step that must commit refuses to move on without one', async () => {
    const { id } = await setup({ autoCommit: true, requireCommit: true });
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/requires a commit/i);
    expect((await item(id)).status).toBe('PLAN');
  });

  it('flag off: staged work is left alone', async () => {
    const { id, dir } = await setup({});
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    expect((await validate(id)).status).toBe(200);
    expect(sh('git log --format=%s', dir)).not.toMatch(/step\(/);
    expect(sh('git diff --cached --name-only', dir)).toBe('x.txt');
  });

  it('refuses the flag on the step that ends the flow, where it would do nothing', async () => {
    const f = await agent().post('/flows').send({ name: `sc-${++seq}`, steps: [s('TODO', 0, { isAnchor: true }), s('WORK', 1, { autoCommit: true }), s('DONE', 2, { isAnchor: true })] });
    expect(f.status).toBe(400);
    expect(f.body.error).toMatch(/close commit covers/);
  });

  it('no step commit on the move that ends the flow, even from a flow stored before that was refused', async () => {
    const { id, dir } = await setup({}, 'WORK');
    const project = await storage.getProject((await item(id)).projectId);
    const flow: any = await storage.getFlow((project as any).flowId);
    await storage.updateFlow(flow.id, { steps: flow.steps.map((st: any) => st.name === 'WORK' ? { ...st, autoCommit: true } : st) } as any);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    await validate(id);
    expect(sh('git log --format=%s', dir)).not.toMatch(/step\(/);
  });

});

describe('S10 review: the step commit happens only when the card really leaves', () => {
  const validateWith = (id: string, command: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok', command });

  it('a failing command on an autoCommit step: refused, card stays, nothing committed, the work still staged', async () => {
    const { id, dir } = await setup({ autoCommit: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    const res = await validateWith(id, 'exit 1');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((await item(id)).status).toBe('PLAN');
    expect(sh('git log --format=%s', dir)).not.toMatch(/step\(/);
    expect(sh('git diff --cached --name-only', dir)).toBe('x.txt');
  });

  it('requireCommit after a failed command: the retry still finds the work staged and commits it', async () => {
    const { id, dir } = await setup({ autoCommit: true, requireCommit: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    expect((await validateWith(id, 'exit 1')).status).toBe(422);
    const retry = await validateWith(id, 'exit 0');
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect((await item(id)).status).toBe('WORK');
    expect(sh('git log -1 --format=%s', dir)).toMatch(/^step\(PLAN\)/);
  });

  it('the next step diffs from the step commit, so the step\'s own committed work is not counted again', async () => {
    const f = await agent().post('/flows').send({ name: `sc-${++seq}`, steps: [
      s('TODO', 0, { isAnchor: true }), s('PLAN', 1, { autoCommit: true }),
      s('RED', 2, { checks: [{ id: 'only-test-files-changed' }] }), s('WORK', 3), s('DONE', 4, { isAnchor: true }),
    ] });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const dir = repo();
    const p = await agent().post('/projects').send({ name: `sc-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
    const id = (await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId: p.body.id })).body.id;
    await storage.updateItem(id, { status: 'PLAN' } as any);
    fs.writeFileSync(path.join(dir, 'foo.ts'), 'export const foo = 1;\n'); sh('git add foo.ts', dir);
    expect((await validate(id)).status).toBe(200);
    fs.writeFileSync(path.join(dir, 'foo.test.ts'), 'test\n');
    const red = await validate(id);
    expect(red.status, JSON.stringify(red.body)).toBe(200);
    expect((await item(id)).status).toBe('WORK');
  });

  it('records the sha of the commit it made', async () => {
    const { id, dir } = await setup({ autoCommit: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    const res = await validate(id);
    const rec = await exitOf(id, 'PLAN');
    expect(rec.commit).toBe(sh('git log -1 --format=%H --grep=^step', dir));
    expect(res.body.message).toContain(rec.commit.slice(0, 12));
  });

  it('a step before a mid-flow special step commits: only the move that ends the flow skips it', async () => {
    const f = await agent().post('/flows').send({ name: `sc-${++seq}`, steps: [
      s('TODO', 0, { isAnchor: true }), s('PLAN', 1, { autoCommit: true }), s('HOLD', 2, { isSpecial: true }),
      s('WORK', 3), s('DONE', 4, { isAnchor: true }),
    ] });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const dir = repo();
    const p = await agent().post('/projects').send({ name: `sc-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
    const id = (await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId: p.body.id })).body.id;
    await storage.updateItem(id, { status: 'PLAN' } as any);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(sh('git log -1 --format=%s', dir)).toMatch(/^step\(PLAN\)/);
  });

  it('speaks of the step, not the close: nothing staged does not say to close the card again', async () => {
    const { id } = await setup({ autoCommit: true });
    const res = await validate(id);
    expect(res.body.message).toMatch(/nothing was staged/i);
    expect(res.body.message).not.toMatch(/close it again/i);
  });

  it('a failed step commit says FAILED, like the close commit', async () => {
    const { id, dir } = await setup({ autoCommit: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); sh('git add x.txt', dir);
    // A pre-commit hook that refuses: the commit itself fails.
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/step commit FAILED/);
  });
});

