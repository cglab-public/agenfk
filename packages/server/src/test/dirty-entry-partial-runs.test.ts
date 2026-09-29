/**
 * @file 6e0d2fd6 — partial runs work on the tree agents actually have.
 *
 * Found by the pre-release simulation: on a TDD card, the coding step ran the
 * whole suite although only one source file changed and the project set a
 * relatedCommand. The partial runs required the step's entry capture to be on
 * a CLEAN tree and a WHOLE run - but agents commit only at close, and the
 * coding step is entered through the test-writing step's partial run. Now a
 * capture records its tree's per-file content, and "what changed since the
 * step began" compares that with the tree now, dirty or not.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./dirty-entry-partial-runs-test-db.sqlite');
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


/** START -> SPECS (test-authoring) -> BUILD (coding) -> END, nothing ever committed after the first commit. */
async function setup(sub = false, steps?: any[]) {
  const f = await agent().post('/flows').send({ name: `de-${++seq}`, steps: steps ?? [
    s('START', 0, { isAnchor: true }), s('SPECS', 1, { role: 'test-authoring' }), s('BUILD', 2, { role: 'coding' }), s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const top = tmp('agenfk-de-repo-');
  // With `sub`, the project is a subdirectory of its repository.
  const repo = sub ? path.join(top, 'sub') : top;
  if (sub) { fs.mkdirSync(repo); fs.writeFileSync(path.join(top, 'shared.js'), 'module.exports = 0;\n'); }
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'other.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass adds\n');
  fs.writeFileSync(path.join(repo, 'b.test.js'), 'pass other works\n');
  git(top, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
  const tools = tmp('agenfk-de-tools-');
  const log = path.join(tools, 'runs');
  const deps = path.join(tools, 'deps.json');
  const omit = path.join(tools, 'omit');
  fs.writeFileSync(deps, JSON.stringify({ 'a.test.js': ['lib.js'], 'b.test.js': ['other.js'], 'c.test.js': ['lib.js'] }));
  const runner = path.join(tools, 'runner.js');
  fs.writeFileSync(runner, RUNNER(log, deps, omit));
  const p = await agent().post('/projects').send({ name: `de-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true',
    testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml', relatedCommand: `node ${runner} related {files}` } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `de-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'START' } as any);
  const edit = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { id: c.body.id as string, top, repo, edit, runs };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const statusOf = async (id: string) => ((await storage.getItem(id)) as any).status;
const lastCapture = async (id: string) => ((((await storage.getItem(id)) as any)?.stepRecords ?? []) as any[]).filter(r => r.kind === 'capture').pop();

describe('6e0d2fd6: partial runs on a dirty tree, after a partial run', () => {
  it('the coding step runs only the tests the source change affects, though nothing was committed', async () => {
    const t = await setup();
    expect((await validate(t.id)).status).toBe(200);            // START -> SPECS: a whole run, the entry baseline
    t.edit('c.test.js', 'fail new rule\n');
    expect((await validate(t.id)).status).toBe(200);            // SPECS -> BUILD: a partial run of the new test file
    expect(await statusOf(t.id)).toBe('BUILD');
    t.edit('lib.js', 'module.exports = 10;\n');
    t.edit('c.test.js', 'pass new rule\n');
    const r = await validate(t.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(t.runs().at(-1)).toEqual({ related: ['c.test.js', 'lib.js'], ran: ['a.test.js', 'c.test.js'] });
    const rec = await lastCapture(t.id);
    expect(rec).toMatchObject({ lazy: true, related: true });
    expect(rec.tests.map((x: any) => x.file).sort()).toEqual(['a.test.js', 'b.test.js', 'c.test.js']);
  });

  it('a file written during the coding step counts as that step\'s change', async () => {
    const t = await setup();
    expect((await validate(t.id)).status).toBe(200);
    t.edit('c.test.js', 'fail new rule\n');
    expect((await validate(t.id)).status).toBe(200);
    // A new file written while coding (untracked, uncommitted) is part of what changed. A code file: anything else
    // means the whole suite (de5e5a03), which would not show whether it was seen.
    t.edit('util.js', 'module.exports = 4;\n');
    t.edit('lib.js', 'module.exports = 10;\n');
    t.edit('c.test.js', 'pass new rule\n');
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runs().at(-1)).toEqual({ related: ['c.test.js', 'lib.js', 'util.js'], ran: ['a.test.js', 'c.test.js'] });
  });

  it('in a project that is a subdirectory, a TRACKED file edited while coding is part of what changed', async () => {
    const t = await setup(true);
    expect((await validate(t.id)).status).toBe(200);
    t.edit('c.test.js', 'fail new rule\n');
    expect((await validate(t.id)).status).toBe(200);
    expect(await statusOf(t.id)).toBe('BUILD');
    // other.js is tracked and committed: its per-file entry must follow the edit, not keep the index's stale hash.
    t.edit('other.js', 'module.exports = 20;\n');
    t.edit('c.test.js', 'pass new rule\n');
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runs().at(-1)).toEqual({ related: ['c.test.js', 'other.js'], ran: ['b.test.js', 'c.test.js'] });
  });

  // de5e5a03 (review of 6caae168, finding 3): the entry's file map covers the project's root only. A change beside
  // it that was there when the entry ran and is gone now shows in no diff against HEAD - yet the entry's results
  // were taken with it. Its outside state is recorded too, and a different one means the whole suite.
  it('in a project that is a subdirectory, a change beside it at entry that is reverted since: the whole suite runs', async () => {
    const t = await setup(true, [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'suite-green' }] }), s('BUILD', 2, { checks: [{ id: 'suite-green' }] }), s('END', 3, { isAnchor: true }),
    ]);
    expect((await validate(t.id)).status).toBe(200);                                  // START -> PLAN on the clean tree
    fs.writeFileSync(path.join(t.top, 'shared.js'), 'module.exports = 99;\n');   // someone's work beside the project
    t.edit('lib.js', 'module.exports = 10;\n');
    expect((await validate(t.id)).status).toBe(200);                                  // PLAN -> BUILD: a dirty entry, shared.js modified
    expect(await statusOf(t.id)).toBe('BUILD');
    git(t.top, 'git checkout -q -- shared.js');                                     // ... and it is gone again
    t.edit('lib.js', 'module.exports = 11;\n');
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runs().at(-1)).toBe('ALL');
  });

  // 83c1cbca (second review, finding 3; user 2026-09-28): work beside the project that is the same as at entry does
  // not refuse a partial run - in a shared monorepo worktree there nearly always is some.
  it('in a project that is a subdirectory, a change beside it that is unchanged since entry: only the affected tests run', async () => {
    const t = await setup(true, [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'suite-green' }] }), s('BUILD', 2, { checks: [{ id: 'suite-green' }] }), s('END', 3, { isAnchor: true }),
    ]);
    expect((await validate(t.id)).status).toBe(200);
    fs.writeFileSync(path.join(t.top, 'shared.js'), 'module.exports = 99;\n');
    fs.writeFileSync(path.join(t.top, 'scratch.txt'), 'someone else\'s untracked file\n');
    t.edit('lib.js', 'module.exports = 10;\n');
    expect((await validate(t.id)).status).toBe(200);                                  // PLAN -> BUILD: entry with work beside it
    t.edit('lib.js', 'module.exports = 11;\n');                                       // ... which is left as it was
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runs().at(-1)).toEqual({ related: ['lib.js'], ran: ['a.test.js'] });
  });

  it('in a project that is a subdirectory, a change beside it that moved on since entry: the whole suite runs', async () => {
    const t = await setup(true, [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'suite-green' }] }), s('BUILD', 2, { checks: [{ id: 'suite-green' }] }), s('END', 3, { isAnchor: true }),
    ]);
    expect((await validate(t.id)).status).toBe(200);
    fs.writeFileSync(path.join(t.top, 'shared.js'), 'module.exports = 99;\n');
    t.edit('lib.js', 'module.exports = 10;\n');
    expect((await validate(t.id)).status).toBe(200);
    fs.writeFileSync(path.join(t.top, 'shared.js'), 'module.exports = 100;\n');
    t.edit('lib.js', 'module.exports = 11;\n');
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runs().at(-1)).toBe('ALL');
  });
});

