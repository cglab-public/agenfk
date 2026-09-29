/**
 * @file 2ebacb23 (story e6e34594, CGLAB-164) - the dry run: what leaving the
 * step will run ON THIS TREE, predicted without running anything.
 *
 * GET /items/:id/leave-plan?predict=1 adds, to the static plan, the mode the
 * run would take now: a reuse of a green of this very tree, only the test
 * files changed since the step's entry, only the tests a code change affects,
 * the whole suite, a sibling's green of this tree (final step), or none. Every
 * prediction is checked against the verify that follows it, with a runner that
 * logs which files each run was given, and the dry run itself changes nothing.
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

const TEST_DB = path.resolve('./leave-plan-predict-test-db.sqlite');
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
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A fake vitest: `*.test.js` files hold `pass NAME` / `fail NAME` lines; with file arguments it runs only those. Each run's file list is logged. */
const RUNNER = (log: string) => `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2).filter(a => a !== 'run');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const all = walk('.').filter(f => f.endsWith('.test.js')).sort();
const files = args.length ? args : all;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args.length ? files : 'ALL') + '\\n');
let failed = 0;
const cases = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).map(l => {
  const [st, ...n] = l.split(' ');
  if (st === 'fail') failed++;
  return '<testcase classname="t" name="' + n.join(' ') + '" file="' + f + '">' + (st === 'fail' ? '<failure message="expected 1 to be 2" type="AssertionError"/>' : '') + '</testcase>';
}));
fs.writeFileSync('report.xml', '<testsuites><testsuite name="s">' + cases.join('') + '</testsuite></testsuites>');
process.exit(failed ? 1 : 0);
`;

/** START -> PLAN -> TESTS (existing-tests-still-green) -> END; a card on PLAN. */
async function setup() {
  const f = await agent().post('/flows').send({ name: `pr-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }), s('PLAN', 1),
    s('TESTS', 2, { checks: [{ id: 'existing-tests-still-green' }] }), s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-pr-repo-');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass adds\npass subtracts\n');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
  const tools = tmp('agenfk-pr-tools-');
  const log = path.join(tools, 'runs');
  const runner = path.join(tools, 'vitest.js');
  fs.writeFileSync(runner, RUNNER(log));
  const p = await agent().post('/projects').send({ name: `pr-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner} run`, reportPath: 'report.xml' } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `pr-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { id: c.body.id as string, repo, runs };
}

const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const predict = async (id: string) => {
  const res = await agent().get(`/items/${id}/leave-plan?predict=1`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

/** Into TESTS with its entry capture recorded (a whole run on the clean tree). */
async function enterTests(t: Awaited<ReturnType<typeof setup>>) {
  const res = await validate(t.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(t.runs()).toEqual(['ALL']);
}

describe('GET /items/:id/leave-plan?predict=1', () => {
  it('predicts a reuse when nothing changed since a green of this tree - and verify runs nothing', async () => {
    const t = await setup();
    await enterTests(t);
    const p = await predict(t.id);
    expect(p.prediction).toMatchObject({ mode: 'reuse' });
    await validate(t.id);
    expect(t.runs()).toEqual(['ALL']); // no new run
  });

  it('predicts only the changed test files when only tests changed - and verify runs exactly those', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    const p = await predict(t.id);
    expect(p.prediction).toMatchObject({ mode: 'test-files', files: ['b.test.js'] });
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['b.test.js']]);
  });

  it('predicts the whole suite when code changed and no related-tests command is set - and verify runs it all', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 2;\n');
    const p = await predict(t.id);
    expect(p.prediction).toMatchObject({ mode: 'full' });
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual(['ALL']);
  });

  it('predicts none when leaving runs nothing', async () => {
    const f = await agent().post('/flows').send({ name: `pr-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('A', 1), s('B', 2), s('END', 3, { isAnchor: true })] });
    const repo = tmp('agenfk-pr-none-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo x > f && git add . && git commit -qm one');
    const p = await agent().post('/projects').send({ name: `pr-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'exit 0' } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: `pr-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'A' } as any);
    expect((await predict(c.body.id)).prediction).toMatchObject({ mode: 'none' });
  });

  it("predicts a sibling's green of this tree on the final step - and verify propagates it instead of running", async () => {
    // Propagation reads siblings on DONE, so the exit step carries that name here.
    const f = await agent().post('/flows').send({ name: `pr-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('A', 1), s('DONE', 2, { isAnchor: true })] });
    const repo = tmp('agenfk-pr-sib-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo x > f && git add . && git commit -qm one');
    const p = await agent().post('/projects').send({ name: `pr-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'exit 0' } as never);
    const parent = await agent().post('/items').send({ type: 'STORY', title: `pr-${++seq}`, projectId: p.body.id });
    await storage.updateItem(parent.body.id, { status: 'A' } as any);
    const mk = async () => {
      const c = await agent().post('/items').send({ type: 'TASK', title: `pr-${++seq}`, projectId: p.body.id, parentId: parent.body.id });
      await storage.updateItem(c.body.id, { status: 'A' } as any);
      return c.body.id as string;
    };
    const first = await mk();
    const second = await mk();
    const done = await validate(first);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const pr = await predict(second);
    expect(pr.prediction).toMatchObject({ mode: 'sibling-green' });
    expect(pr.prediction.sibling?.id).toBe(first);
    const res = await validate(second);
    expect(res.body.message).toMatch(/sibling propagation/i);
  });

  it('the dry run changes nothing: no record, no step change, no run', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 3;\n');
    const before: any = await storage.getItem(t.id);
    await predict(t.id);
    const after: any = await storage.getItem(t.id);
    expect(after.status).toBe(before.status);
    expect((after.stepRecords ?? []).length).toBe((before.stepRecords ?? []).length);
    expect(t.runs()).toEqual(['ALL']);
  });

  it('carries a line of advice naming the predicted mode', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    expect((await predict(t.id)).prediction.advice).toMatch(/b\.test\.js/);
  });
});
