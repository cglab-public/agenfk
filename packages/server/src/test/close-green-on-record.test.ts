/**
 * @file ef1342b8 (CGLAB-434) - the move that ends the flow closes on a green of
 * this tree already on record, instead of running the verify command again.
 *
 * The 2.0 lineage simulation (beta.27) found the close re-running the verify
 * command on trees a green was already recorded for: the card's own earlier
 * capture (a card that changed code ran its suite twice), the previous card's
 * close (a no-op or docs-only card ran it once for nothing), and REFACTOR's whole
 * green of the very tree the TDD close then ran again. A green of this tree's
 * content - every file, or every file but the reuse-ignored ones (the user's
 * call) - by the same command, in the same root, stands for the verify command.
 *
 * It holds only where a capture's green would: a test report with paths (the
 * runs it reuses were fenced), the report's command IS the verify command, and
 * no command check runs on the step. The plan says so before the verify, and
 * every case is checked against the verify that follows it.
 */
import { testDbPath } from './helpers/testDb';
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

const TEST_DB = testDbPath('close-green-on-record-test-db.sqlite');
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
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh' });

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-closegreen-'));
  dirs.push(dir);
  git(dir, 'git init -q -b main && git config user.email t@t && git config user.name t');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  git(dir, 'git add . && git commit -qm one');
  return dir;
}

/** A suite writing a JUnit report of two passing tests, counting its runs in a log outside the tree. */
const JUNIT = `printf '<testsuite><testcase file="tests/a.test.js" name="t0"/><testcase file="tests/a.test.js" name="t1"/></testsuite>' > report.xml`;
function counted(tag: string) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-closegreen-log-')), 'runs');
  dirs.push(path.dirname(log));
  return { command: `echo ${tag} >> '${log}'; ${JUNIT}`, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function flow(steps: any[]): Promise<string> {
  const res = await agent().post('/flows').send({ name: `closegreen-${++seq}`, steps });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string, extra: Record<string, unknown>) {
  const p = await agent().post('/projects').send({ name: `closegreen-${++seq}` });
  expect(p.status).toBe(201);
  await storage.updateProject(p.body.id, { flowId, ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
const moveTo = (id: string, status: string) => storage.updateItem(id, { status } as any);
const captureNow = async (id: string) => {
  const r = await agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const predict = async (id: string) => {
  const r = await agent().get(`/items/${id}/leave-plan?predict=1`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.prediction;
};
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const read = async (id: string) => (await agent().get(`/items/${id}?records=1`)).body;

/** A flow whose last working step captures nothing: leaving it runs only the verify command. */
const finalOnly = () => flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('FINAL', 2), s('END', 3, { isAnchor: true, role: 'closing' })]);
const reported = (dir: string, command: string) => ({ projectRoot: dir, verifyCommand: command, testReport: { format: 'junit-xml', reportPath: 'report.xml', command } });

describe('the close stands on a green of this tree already on record (ef1342b8)', () => {
  it("the card's own earlier green of this tree: the close runs nothing, says why, and records the green against the tree", async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'FINAL');
    expect(suite.runs()).toHaveLength(1);

    const p = await predict(id);
    expect(p.mode, JSON.stringify(p)).toBe('reuse');
    expect(p.advice).toMatch(/would not run/);

    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('END');
    expect(suite.runs(), 'the verify command ran over a green of this very tree').toHaveLength(1);
    expect(res.body.message).toMatch(/green of this tree on record/);
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    const tests = (await read(id)).tests ?? [];
    expect(tests.some((t: any) => t.status === 'PASSED' && t.command === suite.command && t.commit === head && t.treeState),
      'the close recorded no green tied to this tree').toBe(true);
  });

  it("another card's green of this tree (a no-op card after a close): the close runs nothing", async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    const first = await card(pid, 'WORK');
    await captureNow(first);
    const id = await card(pid, 'FINAL');

    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs()).toHaveLength(1);
  });

  it('only a reuse-ignored file changed since the green (a docs-only card): the close runs nothing, and records the tree as it is now', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    const id = await card(pid, 'WORK');
    const green = await captureNow(id);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '# notes no test reads\n');
    git(dir, 'git add NOTES.md && git commit -qm docs');
    await moveTo(id, 'FINAL');

    expect((await predict(id)).mode).toBe('reuse');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'a docs-only change re-ran the verify command').toHaveLength(1);
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    const t = ((await read(id)).tests ?? []).find((x: any) => x.status === 'PASSED');
    expect(t?.commit, 'the green was not tied to the commit the card closed at').toBe(head);
    expect(t?.treeState, 'the close recorded no tree state').toEqual(expect.any(String));
    expect(t?.treeState, 'the record carries the old tree, not the one that closed').not.toBe(green.filesState);
  });

  it('a Markdown file a test names changed since the green: it counts as code, and the verify command runs', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'tests/a.test.js'), "test reads 'GUIDE.md'");
    fs.writeFileSync(path.join(dir, 'GUIDE.md'), 'v1\n');
    git(dir, 'git add . && git commit -qm guide');
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    const id = await card(pid, 'WORK');
    await captureNow(id);
    fs.writeFileSync(path.join(dir, 'GUIDE.md'), 'v2\n');
    git(dir, 'git commit -qam guide2');
    await moveTo(id, 'FINAL');

    expect((await predict(id)).mode).toBe('full');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'a file a test reads was treated as docs').toHaveLength(2);
  });

  it("a project that ignores nothing for reuse (reuseIgnore: none): a docs edit runs the verify command", async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), { projectRoot: dir, verifyCommand: suite.command, testReport: { format: 'junit-xml', reportPath: 'report.xml', command: suite.command, reuseIgnore: [] } });
    const id = await card(pid, 'WORK');
    await captureNow(id);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '# notes\n');
    git(dir, 'git add NOTES.md && git commit -qm docs');
    await moveTo(id, 'FINAL');

    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs()).toHaveLength(2);
  });

  it('a green of the same content in ANOTHER checkout: it is not this tree, and the verify command runs', async () => {
    const elsewhere = makeRepo();
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(elsewhere, suite.command));
    const first = await card(pid, 'WORK');
    await captureNow(first);
    await storage.updateProject(pid, { projectRoot: dir } as never);
    const id = await card(pid, 'FINAL');

    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), "another checkout's green closed this card").toHaveLength(2);
  });

  it('code changed since the green: the verify command runs, as the plan says', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    const id = await card(pid, 'WORK');
    await captureNow(id);
    fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 2;\n');
    git(dir, 'git commit -qam code');
    await moveTo(id, 'FINAL');

    expect((await predict(id)).mode).toBe('full');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs()).toHaveLength(2);
  });

  it("the report's command is not the verify command: the verify command still runs", async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const gate = counted('gate');
    const pid = await project(await finalOnly(), { projectRoot: dir, verifyCommand: gate.command, testReport: { format: 'junit-xml', reportPath: 'report.xml', command: suite.command } });
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'FINAL');

    expect((await predict(id)).mode).toBe('full');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(gate.runs(), 'a green of another command stood for the verify command').toHaveLength(1);
  });

  it('a final step whose capture reuses the green (the default flow\'s TEST): the reused green closes the card, no second run', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing' }), s('END', 3, { isAnchor: true, role: 'closing' })]), reported(dir, suite.command));
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'TEST');

    const p = await predict(id);
    expect(p.mode).toBe('reuse');
    expect(p.command?.mode, 'the plan still promised the verify command after the reuse').toBe('reuse');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'a reused green of this tree was followed by the same command').toHaveLength(1);
  });

  it('a command check on the step: it may build what the tree state cannot see, so the verify command runs', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const lint = { id: 'command-check', params: { name: 'lint', argv: [process.execPath, '-e', 'process.exit(0)'] } };
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('FINAL', 2, { checks: [lint] }), s('END', 3, { isAnchor: true, role: 'closing' })]), reported(dir, suite.command));
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'FINAL');

    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs()).toHaveLength(2);
  });
});
