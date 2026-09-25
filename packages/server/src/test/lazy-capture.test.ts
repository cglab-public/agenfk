/**
 * @file acceaa54 — a step that changed only test files runs just those files.
 *
 * Leaving a test-writing step ran the whole suite, although nothing but test
 * files had changed since the step's entry capture: every other file's tests
 * must give their entry results. When the entry capture is per-test and was
 * taken on a clean tree, every file changed since (committed or not, anyone's)
 * is a test file, and the runner takes a file list, only the changed test
 * files run and their results are merged over the entry's. The merged record
 * says so and is never reused as a green. Anything else runs the whole suite.
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

const TEST_DB = path.resolve('./lazy-capture-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN, stampCloseGreen } from '../server';

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

/**
 * A fake runner in a file named vitest.js (so it is recognised as one that
 * takes a file list). Each `*.test.js` file holds lines `pass NAME` or
 * `fail NAME`. With file arguments it runs only those; without, every test
 * file in the tree. Every run's file list is logged outside the tree.
 */
const RUNNER = (log: string) => `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2).filter(a => a !== 'run');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const all = walk('.').filter(f => f.endsWith('.test.js')).sort();
const files = args.length ? args : all;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args.length ? files : 'ALL') + '\\n');
let failed = 0, crash = false, dirty = false;
const cases = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).filter(l => !(l === 'exit' && (crash = true)) && !(l === 'dirty' && (dirty = crash = true))).map(l => {
  const [st, ...n] = l.split(' ');
  if (st === 'fail') failed++;
  return '<testcase classname="t" name="' + n.join(' ') + '" file="' + f + '">' + (st === 'fail' ? '<failure message="expected 1 to be 2" type="AssertionError"/>' : '') + '</testcase>';
}));
fs.writeFileSync('report.xml', '<testsuites><testsuite name="s">' + cases.join('') + '</testsuite></testsuites>');
if (dirty) fs.writeFileSync('dirt.txt', 'left behind');
process.exit(crash ? 3 : failed ? 1 : 0);
`;

/** START -> PLAN -> TESTS (existing-tests-still-green: leaving PLAN records the entry, leaving TESTS captures) -> END. */
async function setup(opts: { runnerName?: string; sub?: boolean } = {}) {
  const f = await agent().post('/flows').send({ name: `lz-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }),
    s('PLAN', 1),
    s('TESTS', 2, { checks: [{ id: 'existing-tests-still-green' }] }),
    s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const top = tmp('agenfk-lz-repo-');
  // With `sub`, the project is a subdirectory of its repository.
  const repo = opts.sub ? path.join(top, 'sub') : top;
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass adds\npass subtracts\n');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
  git(top, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
  const tools = tmp('agenfk-lz-tools-');
  const log = path.join(tools, 'runs');
  const runner = path.join(tools, opts.runnerName ?? 'vitest.js');
  fs.writeFileSync(runner, RUNNER(log));
  const p = await agent().post('/projects').send({ name: `lz-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner} run`, reportPath: 'report.xml' } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `lz-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { id: c.body.id as string, pid: p.body.id as string, repo, top, runs };
}

const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const records = async (id: string) => (((await storage.getItem(id)) as any)?.stepRecords ?? []) as any[];
const captureAt = async (id: string, step: string) => (await records(id)).filter(r => r.kind === 'capture' && r.step === step).pop();
const verdicts = (tests: any[]) => tests.map(t => `${t.name}=${t.status}`).sort();

/** Into TESTS with its entry capture recorded (a whole run on the clean tree). */
async function enterTests(t: Awaited<ReturnType<typeof setup>>) {
  const res = await validate(t.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((await storage.getItem(t.id) as any).status).toBe('TESTS');
  expect(t.runs()).toEqual(['ALL']);
  expect(await captureAt(t.id, 'PLAN')).toMatchObject({ clean: true, available: true });
}

describe('acceaa54: a test-only change runs only the changed test files', () => {
  it('runs just the new test file, and the merged verdicts are those of a whole run on the same tree', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'fail multiplies\npass divides\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['b.test.js']]);
    const lazy = await captureAt(t.id, 'TESTS');
    expect(lazy).toMatchObject({ lazy: true, ranFiles: ['b.test.js'], available: true, exitCode: 1 });
    // The same tree, captured whole.
    const full = await agent().post(`/items/${t.id}/step-records/capture`).set(internal()).send({});
    expect(full.status).toBe(200);
    expect(t.runs().slice(-1)).toEqual(['ALL']);
    expect(verdicts(lazy.tests)).toEqual(verdicts(full.body.tests));
  });

  it('re-runs an edited test file, replacing its entry results', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'a.test.js'), 'pass adds\nfail subtracts\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['a.test.js']]);
    const lazy = await captureAt(t.id, 'TESTS');
    const byName = Object.fromEntries(lazy.tests.map((x: any) => [x.name.split(' > ').pop(), x.status]));
    expect(byName).toEqual({ adds: 'passed', subtracts: 'failed' });
  });

  it("a deleted test file's tests disappear", async () => {
    const t = await setup();
    await enterTests(t);
    fs.rmSync(path.join(t.repo, 'a.test.js'));
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['b.test.js']]);
    const lazy = await captureAt(t.id, 'TESTS');
    expect(lazy.lazy).toBe(true);
    expect(lazy.tests.map((x: any) => x.file)).toEqual(['b.test.js']);
  });

  it('a code change falls back to the whole suite', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 2;\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual(['ALL']);
    expect((await captureAt(t.id, 'TESTS')).lazy).toBeUndefined();
  });

  it('a runner not known to take a file list falls back to the whole suite', async () => {
    const t = await setup({ runnerName: 'runner.js' });
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual(['ALL']);
  });

  it('an entry captured on a dirty tree falls back: what changed since it cannot be told from git', async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.repo, 'wip.test.js'), 'pass wip\n');
    expect((await validate(t.id)).status).toBe(200);
    expect((await captureAt(t.id, 'PLAN')).clean).toBe(false);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect(t.runs()).toEqual(['ALL', 'ALL']);
  });

  it('a merged record is never stamped or reused as a green', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect((await captureAt(t.id, 'TESTS')).lazy).toBe(true);
    const sha = git(t.repo, 'git add -A && git commit -qm close && git rev-parse HEAD');
    // The only per-test run on these files is the merged one: nothing to stamp.
    expect(await stampCloseGreen(t.id, t.repo, sha)).toBeNull();
  });

  it("the merged exit code is the merged results': a file failing at entry and not re-run still fails", async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.repo, 'c.test.js'), 'fail broken\n');
    git(t.repo, 'git add . && git commit -qm c');
    await enterTests(t);
    expect((await captureAt(t.id, 'PLAN')).exitCode).not.toBe(0);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    const lazy = await captureAt(t.id, 'TESTS');
    expect(lazy).toMatchObject({ lazy: true, ranFiles: ['b.test.js'] });
    expect(lazy.exitCode).not.toBe(0);
  });

  // Review of acceaa54: what makes a partial run unable to stand for the whole suite.
  it('a changed helper beside the tests means the whole suite: other files import it', async () => {
    const t = await setup();
    await enterTests(t);
    fs.mkdirSync(path.join(t.repo, 'test'));
    fs.writeFileSync(path.join(t.repo, 'test', 'helpers.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual(['ALL']);
  });

  it('a partial run that fails without failing a test it ran is replaced by the whole suite', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\nexit\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['b.test.js'], 'ALL']);
    const cap = await captureAt(t.id, 'TESTS');
    expect(cap.lazy).toBeUndefined();
    expect(cap.exitCode).toBe(3);
  });

  it('a file it ran but whose results the report does not name is replaced by the whole suite', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'empty.test.js'), '');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['empty.test.js'], 'ALL']);
    expect((await captureAt(t.id, 'TESTS')).lazy).toBeUndefined();
  });

  it('a rename is a deletion plus an addition: the old name\'s tests do not survive it', async () => {
    const t = await setup();
    await enterTests(t);
    git(t.repo, 'git mv a.test.js moved.test.js');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['moved.test.js']]);
    const lazy = await captureAt(t.id, 'TESTS');
    expect(lazy.lazy).toBe(true);
    expect([...new Set(lazy.tests.map((x: any) => x.file))]).toEqual(['moved.test.js']);
  });

  it('a project in a subdirectory of its repository sees its changed files by their own paths', async () => {
    const t = await setup({ sub: true });
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'a.test.js'), 'pass adds\nfail subtracts\n');
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['a.test.js', 'b.test.js']]);
    const lazy = await captureAt(t.id, 'TESTS');
    const byName = Object.fromEntries(lazy.tests.map((x: any) => [x.name.split(' > ').pop(), x.status]));
    expect(byName).toEqual({ adds: 'passed', subtracts: 'failed', divides: 'passed' });
  });

  it('a project in a subdirectory: a change beside it, outside its root, means the whole suite', async () => {
    const t = await setup({ sub: true });
    await enterTests(t);
    fs.writeFileSync(path.join(t.top, 'shared.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\n');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual(['ALL']);
  });

  it('the whole-suite fallback reads the tree afresh: dirtied during the partial run, its record says dirty', async () => {
    const t = await setup();
    await enterTests(t);
    fs.writeFileSync(path.join(t.repo, 'b.test.js'), 'pass divides\ndirty\n');
    git(t.repo, 'git add b.test.js && git commit -qm b');
    expect(git(t.repo, 'git status --porcelain')).toBe('');
    await validate(t.id);
    expect(t.runs().slice(1)).toEqual([['b.test.js'], 'ALL']);
    const cap = await captureAt(t.id, 'TESTS');
    expect(cap.lazy).toBeUndefined();
    expect(cap.clean).toBe(false);
  });
});
