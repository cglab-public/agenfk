/**
 * @file 37a292a7 (story e6e34594, CGLAB-164) - the leave plan: what `agenfk
 * verify` will run on leaving the step a card is on, told BEFORE it runs.
 *
 * Agents ran the whole suite themselves and then verify ran it again: they
 * could not know that leaving the step runs it (a check needs its results, the
 * next step records its entry, or the final step runs the verify command) - or
 * that it runs nothing, and the tests the exit criteria ask for are theirs.
 * GET /items/:id/leave-plan answers from the same predicate the step gate runs
 * on, and every case here is checked against the verify that follows it: the
 * plan and the run must not disagree.
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

const TEST_DB = path.resolve('./leave-plan-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN, ownCaptureGreenOf } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-leaveplan-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

/** A command writing a JUnit report of two passing tests, and the project settings that read it. */
const JUNIT = `printf '<testsuite><testcase file="tests/a.test.js" name="t0"/><testcase file="tests/a.test.js" name="t1"/></testsuite>' > report.xml`;
const withReport = (dir: string) => ({ projectRoot: dir, verifyCommand: JUNIT, testReport: { format: 'junit-xml', reportPath: 'report.xml' } });

let seq = 0;
async function flow(steps: any[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent().post('/flows').send({ name: `leave-${++seq}`, steps, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string, extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `leave-${++seq}` });
  expect(p.status).toBe(201);
  await storage.updateProject(p.body.id, { flowId, ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const plan = async (id: string) => {
  const res = await agent().get(`/items/${id}/leave-plan`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const capturesOf = async (id: string, step: string) =>
  (((await agent().get(`/items/${id}`)).body.stepRecords ?? []) as any[]).filter(r => r?.kind === 'capture' && r.step === step);

const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

describe('GET /items/:id/leave-plan', () => {
  it("a step whose checks need the suite: it runs, names the checks, and tells the agent not to run it first - and verify does run it", async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const id = await card(pid, 'MAKE');
    const p = await plan(id);
    expect(p).toMatchObject({ step: 'MAKE', next: 'CHECK', runs: 'suite', entryBaseline: null });
    expect(p.checks).toContain('suite-green');
    expect(p.advice).toMatch(/don't run the (full )?suite (yourself )?first/i);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await capturesOf(id, 'MAKE')).toHaveLength(1);
  });

  it('a step with no test checks, before a step that records nothing: nothing runs, and the tests are the agent\'s - and verify runs none', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('WORK', 2), s('CHECK', 3, { role: 'review' }), s('END', 4, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const id = await card(pid, 'WORK');
    const p = await plan(id);
    expect(p).toMatchObject({ step: 'WORK', next: 'CHECK', runs: 'nothing', checks: [], entryBaseline: null });
    expect(p.advice).toMatch(/runs no tests/i);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await capturesOf(id, 'WORK')).toHaveLength(0);
  });

  it("the final step: the project's verify command runs, and the plan names it", async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })]), { projectRoot: dir, verifyCommand: 'exit 0' });
    const id = await card(pid, 'CHECK');
    const p = await plan(id);
    expect(p).toMatchObject({ step: 'CHECK', next: 'END', runs: 'verify-command', command: 'exit 0' });
    expect(p.advice).toMatch(/exit 0/);
    expect(p.advice).toMatch(/don't run (it|the (full )?suite) (yourself )?first/i);
  });

  it("a next step that records its entry: leaving runs the suite for that baseline, even with no check of this step - and verify does", async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('TESTS', 2, { role: 'test-authoring' }), s('MAKE', 3, { role: 'coding' }), s('END', 4, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const id = await card(pid, 'PLAN');
    const p = await plan(id);
    expect(p).toMatchObject({ step: 'PLAN', next: 'TESTS', runs: 'suite', entryBaseline: 'TESTS' });
    expect(p.advice).toMatch(/TESTS/);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await capturesOf(id, 'PLAN')).toHaveLength(1);
  });

  it('a next step that needs a per-test baseline this project cannot record: the plan says the card will be held, and runs nothing - as verify does', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('TESTS', 2, { role: 'test-authoring' }), s('MAKE', 3, { role: 'coding' }), s('END', 4, { isAnchor: true, role: 'closing' })]), { projectRoot: dir, verifyCommand: 'exit 0' });
    const id = await card(pid, 'PLAN');
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'nothing' });
    expect(p.held).toMatch(/TESTS/);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(await capturesOf(id, 'PLAN')).toHaveLength(0);
  });

  it("verifyAt 'parent', with the parent open in the same tree: the suite is deferred to the parent", async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })], { verifyAt: 'parent' }), { projectRoot: dir, verifyCommand: 'exit 0' });
    const parent = await card(pid, 'WORK');
    const id = await card(pid, 'CHECK', { parentId: parent });
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'nothing' });
    expect(p.deferredTo?.id).toBe(parent);
    expect(p.advice).toMatch(/parent/i);
  });

  it("a step waiting on a person's approval: says the suite runs only after the approval", async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning', checks: [{ id: 'human-approval' }, { id: 'suite-green' }] }), s('WORK', 2), s('END', 3, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const id = await card(pid, 'PLAN');
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'suite', waitsOnPerson: true });
    expect(p.advice).toMatch(/approv/i);
  });

  it('with a related-tests command, says leaving may run only the tests the change affects', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('MAKE', 2, { role: 'coding' }), s('CHECK', 3, { role: 'review' }), s('END', 4, { isAnchor: true, role: 'closing' })]),
      { ...withReport(dir), testReport: { format: 'junit-xml', reportPath: 'report.xml', relatedCommand: 'npx vitest related --run {files}' } });
    const id = await card(pid, 'MAKE');
    const p = await plan(id);
    expect(p.runs).toBe('suite');
    expect(p.narrowing).toContain('affected-tests');
  });

  /** A log outside the tree (a write inside it would move the tree under the run), and a command that counts its runs in it. */
  const counted = (tag: string, then = '') => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-leaveplan-log-')), 'runs');
    repos.push(path.dirname(log));
    return { log, command: `echo ${tag} >> '${log}'${then ? `; ${then}` : ''}`, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
  };

  it('the final step with a test report whose command IS the verify command: the suite runs once, and its green closes the card (36c5ca25)', async () => {
    const dir = makeRepo();
    const suite = counted('suite', JUNIT);
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing' }), s('END', 3, { isAnchor: true, role: 'closing' })]),
      { projectRoot: dir, verifyCommand: suite.command, testReport: { format: 'junit-xml', reportPath: 'report.xml' } });
    const id = await card(pid, 'TEST');
    const p = await plan(id);
    expect(p.runs).toBe('suite');
    expect(p.thenCommand, 'the plan promised a second run of the same command').toBeUndefined();
    expect(p.advice).not.toMatch(/then the project's verify command/i);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('END');
    expect(suite.runs(), 'the same suite ran twice on one move').toHaveLength(1);
    expect(await capturesOf(id, 'TEST')).toHaveLength(1);
    const tests = (await agent().get(`/items/${id}`)).body.tests ?? [];
    expect(tests.some((t: any) => t.command === suite.command && t.status === 'PASSED' && t.commit), 'the close recorded no green tied to its commit').toBe(true);
  });

  it('the final step with a test report whose command differs from the verify command: both run - the plan says both, and verify does both', async () => {
    const dir = makeRepo();
    const suite = counted('suite', JUNIT);
    const gate = counted('gate');
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing' }), s('END', 3, { isAnchor: true, role: 'closing' })]),
      { projectRoot: dir, verifyCommand: gate.command, testReport: { format: 'junit-xml', reportPath: 'report.xml', command: suite.command } });
    const id = await card(pid, 'TEST');
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'suite', command: suite.command, thenCommand: gate.command });
    expect(p.advice).toMatch(/then the project's verify command/i);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(suite.runs()).toHaveLength(1);
    expect(gate.runs(), 'the verify command never gated the close').toHaveLength(1);
  });

  it('a mid-flow boundary next, with the same command: the plan keeps the command after the capture, as verify runs it (36c5ca25 review)', async () => {
    const dir = makeRepo();
    const suite = counted('suite', JUNIT);
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('A', 1, { role: 'testing' }), s('HOLD', 2, { isSpecial: true }), s('B', 3), s('END', 4, { isAnchor: true, role: 'closing' })]),
      { projectRoot: dir, verifyCommand: suite.command, testReport: { format: 'junit-xml', reportPath: 'report.xml' } });
    const id = await card(pid, 'A');
    const p = await plan(id);
    expect(p.closesOnCapture, 'a move that does not end the flow closed on its capture').toBeUndefined();
    expect(p).toMatchObject({ runs: 'suite', thenCommand: suite.command });
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('HOLD');
    expect(suite.runs(), 'the capture and then the command, as the plan said').toHaveLength(2);
  });

  it('with no report to fence the capture, the plan keeps the command after it: the capture cannot close the card (36c5ca25 review)', async () => {
    const dir = makeRepo();
    const suite = counted('suite', JUNIT);
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing' }), s('END', 3, { isAnchor: true, role: 'closing' })]),
      { projectRoot: dir, verifyCommand: suite.command, testReport: { format: 'junit-xml' } });
    const id = await card(pid, 'TEST');
    const p = await plan(id);
    expect(p.closesOnCapture).toBeUndefined();
    expect(p.thenCommand).toBe(suite.command);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(suite.runs(), 'an unfenced capture closed the card').toHaveLength(2);
  });

  it('a command check on the step: it runs after the capture, so the verify command runs after it too - the plan says so (36c5ca25 review)', async () => {
    const dir = makeRepo();
    const suite = counted('suite', JUNIT);
    const lint = { id: 'command-check', params: { name: 'lint', argv: [process.execPath, '-e', 'process.exit(0)'] } };
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing', checks: [lint] }), s('END', 3, { isAnchor: true, role: 'closing' })]),
      { projectRoot: dir, verifyCommand: suite.command, testReport: { format: 'junit-xml', reportPath: 'report.xml' } });
    const id = await card(pid, 'TEST');
    const p = await plan(id);
    expect(p.closesOnCapture, 'closed on a capture a command check ran after').toBeUndefined();
    expect(p.thenCommand).toBe(suite.command);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(suite.runs()).toHaveLength(2);
  });

  /*
   * The helper itself, over real captures: what the close may and may not
   * stand on. Only a green that RAN on this move, of this command, in this
   * root, with the tree still in the state it ran on.
   */
  describe('ownCaptureGreenOf (36c5ca25)', () => {
    const captureNow = async (id: string) => {
      const r = await agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    const setupCapture = async () => {
      const dir = makeRepo();
      // The report's command named, as TestReportSetting requires (reuse matches on it).
      const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('TEST', 1, { role: 'testing' }), s('END', 2, { isAnchor: true, role: 'closing' })]),
        { projectRoot: dir, verifyCommand: JUNIT, testReport: { format: 'junit-xml', reportPath: 'report.xml', command: JUNIT } });
      const id = await card(pid, 'TEST');
      return { dir, id, project: await storage.getProject(pid) };
    };

    it('stands on a whole green of the same command, in the same root, on an unchanged tree', async () => {
      const t = await setupCapture();
      const rec = await captureNow(t.id);
      expect(rec.filesState, 'the capture was not fenced').toBeTruthy();
      expect(ownCaptureGreenOf(rec, JUNIT, t.dir, t.project)).toBe(rec);
    });

    it('refuses once the tree moved after the capture', async () => {
      const t = await setupCapture();
      const rec = await captureNow(t.id);
      fs.appendFileSync(path.join(t.dir, 'tests/a.test.js'), '\nmore');
      expect(ownCaptureGreenOf(rec, JUNIT, t.dir, t.project)).toBeNull();
    });

    it('refuses a green REUSED from an earlier run: nothing ran on this move', async () => {
      const t = await setupCapture();
      await captureNow(t.id);
      const other = await card(t.project!.id, 'TEST');
      const again = await captureNow(other);
      expect(again.reusedFrom, 'the second capture ran instead of reusing').toBeTruthy();
      expect(ownCaptureGreenOf(again, JUNIT, t.dir, t.project)).toBeNull();
    });

    it('refuses another command, another root, a partial run, and a red run', async () => {
      const t = await setupCapture();
      const rec = await captureNow(t.id);
      expect(ownCaptureGreenOf(rec, 'npm test', t.dir, t.project)).toBeNull();
      expect(ownCaptureGreenOf({ ...rec, root: '/elsewhere' }, JUNIT, t.dir, t.project)).toBeNull();
      expect(ownCaptureGreenOf({ ...rec, lazy: true }, JUNIT, t.dir, t.project)).toBeNull();
      expect(ownCaptureGreenOf({ ...rec, exitCode: 1 }, JUNIT, t.dir, t.project)).toBeNull();
    });
  });

  it('the final step: a capture red on the same command never closes the card, and the command is not run over it', async () => {
    const dir = makeRepo();
    const suite = counted('suite', `${JUNIT}; exit 1`);
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing' }), s('END', 3, { isAnchor: true, role: 'closing' })]),
      { projectRoot: dir, verifyCommand: suite.command, testReport: { format: 'junit-xml', reportPath: 'report.xml' } });
    const id = await card(pid, 'TEST');
    await validate(id);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('TEST');
    expect(suite.runs()).toHaveLength(1);
  });

  it('a final step with no verify command: says verify will refuse, not that the tests are the agent\'s - and verify refuses', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })]), { projectRoot: dir });
    const id = await card(pid, 'CHECK');
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'nothing', refuses: 'NO_VERIFY_COMMAND' });
    expect(p.advice).toMatch(/refuse/i);
    expect(p.advice).not.toMatch(/runs no tests/i);
    expect((await validate(id)).status).toBe(400);
  });

  it("verifyAt 'parent' with a capture check of its own: the capture still runs, and the plan says so - as verify does", async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2, { role: 'review', checks: [{ id: 'no-broken-test-files' }] }), s('END', 3, { isAnchor: true, role: 'closing' })], { verifyAt: 'parent' }), withReport(dir));
    const parent = await card(pid, 'WORK');
    const id = await card(pid, 'CHECK', { parentId: parent });
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'suite' });
    expect(p.deferredTo?.id).toBe(parent);
    expect(p.checks).toContain('no-broken-test-files');
    expect(p.advice).not.toMatch(/runs no tests/i);
    await validate(id);
    expect(await capturesOf(id, 'CHECK')).toHaveLength(1);
  });

  it('a card with no tree to run in: says verify cannot run the suite', async () => {
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })]), { verifyCommand: 'exit 0' });
    const id = await card(pid, 'MAKE');
    const p = await plan(id);
    expect(p.refuses).toBe('NO_TREE');
    expect(p.advice).toMatch(/no tree/i);
  });

  it('a mid-flow anchor step: verify skips its checks, so the plan runs nothing', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('PARKED', 2, { isAnchor: true }), s('FIX', 3, { role: 'test-authoring' }), s('END', 4, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const id = await card(pid, 'PARKED');
    expect((await plan(id)).runs).toBe('nothing');
  });

  it('held, with a capture check of its own: the advice names the capture and the hold', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning', checks: [{ id: 'suite-green' }] }), s('TESTS', 2, { role: 'test-authoring' }), s('MAKE', 3, { role: 'coding' }), s('END', 4, { isAnchor: true, role: 'closing' })]), { projectRoot: dir, verifyCommand: 'exit 0' });
    const id = await card(pid, 'PLAN');
    const p = await plan(id);
    expect(p).toMatchObject({ runs: 'suite' });
    expect(p.held).toMatch(/TESTS/);
    expect(p.advice).toMatch(/suite/i);
    expect(p.advice).toMatch(/hold/i);
  });

  it('no tree, but only the verify command runs (no check reads a capture): not a refusal', async () => {
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })]), { verifyCommand: 'exit 0' });
    const id = await card(pid, 'CHECK');
    const p = await plan(id);
    expect(p.runs).toBe('verify-command');
    expect(p.refuses).toBeUndefined();
  });

  it('no tree, and the next step\'s blocking checks need its entry baseline: a refusal - as verify refuses', async () => {
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('TESTS', 2, { role: 'test-authoring' }), s('MAKE', 3, { role: 'coding' }), s('END', 4, { isAnchor: true, role: 'closing' })]), { verifyCommand: JUNIT, testReport: { format: 'junit-xml', reportPath: 'report.xml' } });
    const id = await card(pid, 'PLAN');
    const p = await plan(id);
    expect(p.refuses).toBe('NO_TREE');
    expect((await validate(id)).status).toBe(422);
  });

  it('a mid-flow anchor right before the end: its checks are skipped, but the verify command still runs', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('PARKED', 2, { isAnchor: true }), s('DONE', 3, { isAnchor: true, role: 'closing' })]), { projectRoot: dir, verifyCommand: 'exit 0' });
    const id = await card(pid, 'PARKED');
    expect(await plan(id)).toMatchObject({ runs: 'verify-command', command: 'exit 0' });
  });

  it('404 for an unknown card', async () => {
    expect((await agent().get('/items/does-not-exist/leave-plan')).status).toBe(404);
  });
});

describe('the verify reply tells the agent what leaving the NEXT step runs', () => {
  it('after advancing, names what leaving the step it landed on will run', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('MAKE', 2, { role: 'coding' }), s('CHECK', 3, { role: 'review' }), s('END', 4, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const id = await card(pid, 'PLAN');
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/Leaving MAKE runs the project's suite/);
    expect(res.body.leavePlan).toMatchObject({ step: 'MAKE', runs: 'suite' });
  });
});

describe("GET /projects/:id/flow/leave-plans - each step's plan, for flow show", () => {
  it('lists, per working step, whether leaving it runs the suite, the verify command or nothing', async () => {
    const dir = makeRepo();
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('MAKE', 2, { role: 'coding' }), s('CHECK', 3, { role: 'review' }), s('END', 4, { isAnchor: true, role: 'closing' })]), withReport(dir));
    const res = await agent().get(`/projects/${pid}/flow/leave-plans`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const by = Object.fromEntries((res.body as any[]).map(p => [p.step, p.runs]));
    expect(by).toMatchObject({ PLAN: 'nothing', MAKE: 'suite', CHECK: 'verify-command' });
  });
});
