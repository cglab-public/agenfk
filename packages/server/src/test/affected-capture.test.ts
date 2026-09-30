/**
 * @file a36047ea — a step that changed code runs only the tests it affects.
 *
 * Leaving a coding step ran the whole suite whenever any source file changed.
 * A project that sets `testReport.relatedCommand` (a template with {files},
 * e.g. `npx vitest related --run {files}`) now runs only the tests related to
 * the files changed since the step's entry capture, and merges them over the
 * entry's results for every test file the run did not report - as the
 * test-only lazy run (acceaa54) does. It falls back to the whole suite for a
 * config, lockfile or setup change, a deleted file, a declared surface file,
 * too many files, a change outside the root, a changed test file the run did
 * not report, or an exit no failing test explains. The final step's verify
 * command still runs everything.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./affected-capture-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { describeCapture } from '../checkEngine';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });

/**
 * A fake runner. Test files hold lines `pass NAME` / `fail NAME`. With no
 * arguments it runs every test file; `related` mode takes changed files and
 * runs the test files that depend on them, per a dependency map kept OUTSIDE
 * the tree (so editing it never changes the tree), plus any test file given.
 * An `omit` marker outside the tree makes a related run leave a changed test
 * file out of its report. Every run is logged outside the tree.
 */
const RUNNER = (log: string, deps: string, omit: string) => `
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const related = argv[0] === 'related';
const args = related ? argv.slice(1) : [];
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const all = walk('.').map(f => path.relative('.', f)).filter(f => f.endsWith('.test.js')).sort();
const map = JSON.parse(fs.readFileSync(${JSON.stringify(deps)}, 'utf8'));
let files = related ? all.filter(t => args.includes(t) || (map[t] || []).some(d => args.includes(d))) : all;
if (related && fs.existsSync(${JSON.stringify(omit)})) files = files.filter(f => !args.includes(f));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(related ? { related: args, ran: files } : 'ALL') + '\\n');
let failed = 0;
const cases = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).map(l => {
  const [st, ...n] = l.split(' ');
  if (st === 'fail') failed++;
  return '<testcase classname="t" name="' + n.join(' ') + '" file="' + f + '">' + (st === 'fail' ? '<failure message="expected 1 to be 2" type="AssertionError"/>' : '') + '</testcase>';
}));
fs.writeFileSync('report.xml', '<testsuites><testsuite name="s">' + cases.join('') + '</testsuite></testsuites>');
process.exit(failed ? 1 : 0);
`;

/** START -> PLAN -> BUILD (existing-tests-still-green: leaving PLAN records the entry, leaving BUILD captures) -> END. */
async function setup(opts: { related?: boolean | string; steps?: any[] } = { related: true }) {
  const f = await agent().post('/flows').send({ name: `af-${++seq}`, steps: opts.steps ?? [
    s('START', 0, { isAnchor: true }), s('PLAN', 1), s('BUILD', 2, { checks: [{ id: 'existing-tests-still-green' }] }), s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-af-repo-');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'my lib.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(repo, 'other.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"af","private":true}\n');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass adds\npass subtracts\n');
  fs.writeFileSync(path.join(repo, 'b.test.js'), 'pass other works\n');
  fs.writeFileSync(path.join(repo, 'c.test.js'), 'pass spaced works\n');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
  const tools = tmp('agenfk-af-tools-');
  const log = path.join(tools, 'runs');
  const deps = path.join(tools, 'deps.json');
  const omit = path.join(tools, 'omit');
  fs.writeFileSync(deps, JSON.stringify({ 'a.test.js': ['lib.js'], 'b.test.js': ['other.js'], 'c.test.js': ['my lib.js'] }));
  const runner = path.join(tools, 'runner.js');
  fs.writeFileSync(runner, RUNNER(log, deps, omit));
  const related = opts.related ?? true;
  const relatedCommand = typeof related === 'string' ? related : related ? `node ${runner} related {files}` : undefined;
  const p = await agent().post('/projects').send({ name: `af-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true',
    testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml', ...(relatedCommand ? { relatedCommand } : {}) } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `af-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const edit = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  return { id: c.body.id as string, pid: p.body.id as string, repo, runs, edit, omit: () => fs.writeFileSync(omit, '1') };
}

const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const captureAt = async (id: string, step: string) => ((((await storage.getItem(id)) as any)?.stepRecords ?? []) as any[]).filter(r => r.kind === 'capture' && r.step === step).pop();
const verdicts = (tests: any[]) => tests.map(t => `${t.file}:${t.name}=${t.status}`).sort();

/** Into BUILD with its entry capture recorded (a whole run on the clean tree). */
async function enterBuild(t: Awaited<ReturnType<typeof setup>>) {
  const res = await validate(t.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(((await storage.getItem(t.id)) as any).status).toBe('BUILD');
  expect(t.runs()).toEqual(['ALL']);
}

describe('a36047ea: a code change runs only the tests it affects', () => {
  it('runs the tests related to the changed source file, merged over the entry for the rest', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(t.runs().slice(1)).toEqual([{ related: ['lib.js'], ran: ['a.test.js'] }]);
    const rec = await captureAt(t.id, 'BUILD');
    expect(rec).toMatchObject({ available: true, lazy: true, related: true, ranFiles: ['a.test.js'] });
    // The parser names a test by its file and title.
    expect(verdicts(rec.tests)).toEqual(['a.test.js:a.test.js > adds=passed', 'a.test.js:a.test.js > subtracts=passed', 'b.test.js:b.test.js > other works=passed', 'c.test.js:c.test.js > spaced works=passed']);
  });

  it('says in the reply that it ran only the affected tests', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    const res = await validate(t.id);
    expect(res.body.message).toMatch(/ran the 1 test file\(s\) affected by 1 changed file\(s\)/);
  });

  it('a failure in an affected test refuses the step, like a whole run would', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    t.edit('a.test.js', 'fail adds\npass subtracts\n');
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(t.runs().slice(1)).toEqual([{ related: ['a.test.js', 'lib.js'], ran: ['a.test.js'] }]);
    expect(((await storage.getItem(t.id)) as any).status).toBe('BUILD');
  });

  it('passes each changed file as one argument, spaces and all', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('my lib.js', 'module.exports = 30;\n');
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runs().slice(1)).toEqual([{ related: ['my lib.js'], ran: ['c.test.js'] }]);
  });
});

describe('a36047ea: what still runs the whole suite', () => {
  const whole = async (t: Awaited<ReturnType<typeof setup>>) => {
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(t.runs().slice(1)).toEqual(['ALL']);
    return res;
  };

  it('a project with no relatedCommand', async () => {
    const t = await setup({ related: false });
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    await whole(t);
  });

  it('a package.json change', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('package.json', '{"name":"af","private":true,"type":"module"}\n');
    await whole(t);
  });

  it('a config file change (vitest.config.js)', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('vitest.config.js', 'module.exports = {};\n');
    await whole(t);
  });

  it('a deleted source file', async () => {
    const t = await setup();
    await enterBuild(t);
    fs.rmSync(path.join(t.repo, 'other.js'));
    await whole(t);
  });

  it('a related run that leaves a changed test file out of its report', async () => {
    const t = await setup();
    await enterBuild(t);
    t.omit();
    t.edit('lib.js', 'module.exports = 10;\n');
    t.edit('a.test.js', 'pass adds\npass subtracts\npass multiplies\n');
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(t.runs().slice(1).at(-1)).toBe('ALL');
  });

  it('suggests a relatedCommand when a code change ran everything for want of one', async () => {
    const t = await setup({ related: false });
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    const res = await whole(t);
    expect(res.body.message).toMatch(/--test-report-related-command/);
  });
});

describe('describeCapture', () => {
  it('names an affected-only run for what it was', () => {
    expect(describeCapture({ kind: 'capture', lazy: true, related: true, ranFiles: ['a.test.js', 'b.test.js'], changedFiles: ['lib.js'] }))
      .toMatch(/ran the 2 test file\(s\) affected by 1 changed file\(s\), over its entry results/);
  });
});

describe('PUT /projects/:id/test-report with relatedCommand', () => {
  const put = (id: string, body: Record<string, unknown>) => agent().put(`/projects/${id}/test-report`).set(internal()).send(body);
  const base = { format: 'junit-xml', command: 'node run.js', reportPath: 'report.xml' };

  it('stores a template that takes {files}', async () => {
    const t = await setup({ related: false });
    const r = await put(t.pid, { ...base, relatedCommand: 'npx vitest related --run {files}' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(((await storage.getProject(t.pid)) as any).testReport.relatedCommand).toBe('npx vitest related --run {files}');
  });

  it('refuses a template without {files}, or one that is not text', async () => {
    const t = await setup({ related: false });
    expect((await put(t.pid, { ...base, relatedCommand: 'npx vitest related --run' })).status).toBe(400);
    expect((await put(t.pid, { ...base, relatedCommand: 42 })).status).toBe(400);
  });
});

/*
 * de5e5a03 (review of 6caae168, finding 1): a related run follows imports. A
 * change it cannot trace - a snapshot, a fixture a test reads from disk - left
 * the affected tests out of its report, and the merge kept their entry greens.
 * Only code files the runner's graph follows run affected-only; a related run
 * that finds no test at all means the whole suite; and a testing step, whose
 * whole job is the suite, never runs a part of it.
 */
describe('de5e5a03: an affected-only run never stands in for tests it cannot trace', () => {
  const whole = async (t: Awaited<ReturnType<typeof setup>>) => {
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(t.runs().at(-1)).toBe('ALL');
    return res;
  };

  it('a snapshot changed with the code: the whole suite runs', async () => {
    const t = await setup();
    fs.mkdirSync(path.join(t.repo, '__snapshots__'));
    t.edit('__snapshots__/a.test.js.snap', 'exports[`adds 1`] = `1`;\n');
    git(t.repo, 'git add . && git commit -qm snap');
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    t.edit('__snapshots__/a.test.js.snap', 'exports[`adds 1`] = `10`;\n');
    await whole(t);
    expect(t.runs().slice(1)).toEqual(['ALL']);
  });

  it('a data file a test reads changed: the whole suite runs', async () => {
    const t = await setup();
    t.edit('fixture.json', '{"n":1}\n');
    git(t.repo, 'git add . && git commit -qm fixture');
    await enterBuild(t);
    t.edit('fixture.json', '{"n":2}\n');
    await whole(t);
    expect(t.runs().slice(1)).toEqual(['ALL']);
  });

  it('a related run that finds no test for the change: the whole suite runs after it', async () => {
    const t = await setup();
    await enterBuild(t);
    t.edit('orphan.js', 'module.exports = 5;\n');
    await whole(t);
    expect(t.runs().slice(1)).toEqual([{ related: ['orphan.js'], ran: [] }, 'ALL']);
    expect(await captureAt(t.id, 'BUILD')).not.toHaveProperty('lazy');
  });

  it('a testing step runs the whole suite, even over an affected-only entry', async () => {
    const t = await setup({ steps: [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'suite-green' }] }), s('BUILD', 2, { checks: [{ id: 'suite-green' }] }),
      s('CHECK', 3, { role: 'testing' }), s('SHIP', 4), s('END', 5, { isAnchor: true }),
    ] });
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    expect((await validate(t.id)).status).toBe(200);            // BUILD -> CHECK: a coding change, affected-only
    expect(t.runs().slice(1)).toEqual([{ related: ['lib.js'], ran: ['a.test.js'] }]);
    expect(((await storage.getItem(t.id)) as any).status).toBe('CHECK');
    t.edit('lib.js', 'module.exports = 11;\n');
    await whole(t);                                                // CHECK -> SHIP: the suite, all of it
    expect(await captureAt(t.id, 'CHECK')).not.toHaveProperty('lazy');
  });

  // 83c1cbca (second review, finding 2; user 2026-09-28): refactoring changes code, not tests - where the graph misses most.
  it('a refactoring step runs the whole suite, even over an affected-only entry', async () => {
    const t = await setup({ steps: [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'suite-green' }] }), s('BUILD', 2, { checks: [{ id: 'suite-green' }] }),
      s('TIDY', 3, { role: 'refactoring' }), s('SHIP', 4), s('END', 5, { isAnchor: true }),
    ] });
    await enterBuild(t);
    t.edit('lib.js', 'module.exports = 10;\n');
    expect((await validate(t.id)).status).toBe(200);            // BUILD -> TIDY: affected-only
    expect(t.runs().slice(1)).toEqual([{ related: ['lib.js'], ran: ['a.test.js'] }]);
    expect(((await storage.getItem(t.id)) as any).status).toBe('TIDY');
    t.edit('lib.js', 'module.exports = 11;\n');
    await whole(t);                                                // TIDY -> SHIP: all of it
    expect(await captureAt(t.id, 'TIDY')).not.toHaveProperty('lazy');
  });
});

