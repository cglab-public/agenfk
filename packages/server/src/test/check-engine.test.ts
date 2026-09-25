/**
 * @file CGLAB-380 (S4-T2) — the check engine inside `agenfk verify`.
 *
 * verify resolves the step's checks (universal + role built-ins + flow extras),
 * runs them in the card's tree, and refuses the transition when a blocking one
 * fails, in the verify failure shape old clients already print (422 with a
 * message) plus `checks[]`. Warnings are recorded and never block. Results go
 * on the card. A test report is captured only when a check needs one, and a
 * capture also serves as the NEXT step's entry record, so no suite runs just to
 * snapshot a step's start.
 *
 * Every flow here is written with step names the server has never seen: the
 * engine must work from roles and records alone.
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

const TEST_DB = path.resolve('./check-engine-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { bindRoleLessDefaultFlow } from './helpers/roleLessFlow';

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

function makeRepo(branch = 'main'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-engine-'));
  repos.push(dir);
  execSync(`git init -q -b ${branch} && git config user.email t@t && git config user.name t`, { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

/** A JUnit report with `n` passing tests in tests/a.test.js. */
const junitCommand = (n: number) =>
  `printf '<testsuite>${Array.from({ length: n }, (_, i) => `<testcase file="tests/a.test.js" name="t${i}"/>`).join('')}</testsuite>' > report.xml`;

let seq = 0;
async function flow(steps: any[]): Promise<string> {
  const res = await agent().post('/flows').send({ name: `engine-${++seq}`, steps });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string | null, extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `engine-${++seq}` });
  expect(p.status).toBe(201);
  await storage.updateProject(p.body.id, { ...(flowId ? { flowId } : {}), ...extra } as never);
  // No flow: the default flow as it was before it had roles (a role-less flow).
  if (!flowId) await bindRoleLessDefaultFlow(storage, p.body.id);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string, body: Record<string, unknown> = {}) =>
  agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...body });
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
const byId = (checks: any[], id: string) => checks.find((c: any) => c.id === id);

const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
/** start (anchor) -> make (coding) -> check (review) -> end (anchor). */
const codingFlow = () => [s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })];

describe('CGLAB-380: the check engine in verify', () => {
  describe('universal checks', () => {
    it('refuses to leave the first step with a dirty tree, in the verify failure shape plus checks[]', async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'dirty');
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir }), 'START');
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(res.body.status).toBe('START');
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toMatch(/tree-clean/);
      expect(byId(res.body.checks, 'tree-clean')).toMatchObject({ outcome: 'fail', severity: 'block' });
      expect((await item(id)).status).toBe('START');
    });

    it('advances from a clean first step and records the results on the card and on the exit record', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir }), 'START');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const got = await item(id);
      expect(got.status).toBe('MAKE');
      expect(got.lastChecks.step).toBe('START');
      expect(byId(got.lastChecks.results, 'tree-clean').outcome).toBe('pass');
      const exit = got.stepRecords.find((r: any) => r.kind === 'exit' && r.step === 'START');
      expect(byId(exit.checks, 'tree-clean').outcome).toBe('pass');
    });

    it('refuses to leave a step while the tree is on another branch than the card\'s', async () => {
      const dir = makeRepo('main');
      const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('END', 2, { isAnchor: true })]), { projectRoot: dir, verifyCommand: 'exit 0' });
      const id = await card(pid, 'PLAN', { branchName: 'feat/ABC-1_thing' });
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'on-card-branch')).toMatchObject({ outcome: 'fail' });
      expect(byId(res.body.checks, 'on-card-branch').detail).toMatch(/feat\/ABC-1_thing/);
    });

    it('takes the branch from the top-level item when the card has none of its own', async () => {
      const dir = makeRepo('main');
      const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('END', 2, { isAnchor: true })]), { projectRoot: dir, verifyCommand: 'exit 0' });
      const parent = await card(pid, 'PLAN', { branchName: 'feat/ABC-2_parent' });
      const id = await card(pid, 'PLAN', { parentId: parent });
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'on-card-branch').detail).toMatch(/feat\/ABC-2_parent/);
    });

    it('on a flow with no roles, the universal checks only warn: an upgrade never starts blocking cards', async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'dirty');
      const id = await card(await project(null, { projectRoot: dir }), 'TODO');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.message).toMatch(/tree-clean/);
      const got = await item(id);
      expect(byId(got.lastChecks.results, 'tree-clean')).toMatchObject({ outcome: 'fail', severity: 'warn' });
    });
  });

  describe('capture on demand', () => {
    it('suite-green runs the project command and refuses on a red suite (exit-code fallback, no test report set)', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir, verifyCommand: 'exit 3' }), 'MAKE');
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'suite-green')).toMatchObject({ outcome: 'fail', severity: 'block' });
      expect((await item(id)).status).toBe('MAKE');
    });

    it('suite-green passes on a green suite and the card advances', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir, verifyCommand: 'exit 0' }), 'MAKE');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await item(id)).status).toBe('CHECK');
      expect(byId((await item(id)).lastChecks.results, 'suite-green').outcome).toBe('pass');
    });

    it('suite-green reads the per-test report: a failing test blocks even when the command exits 0', async () => {
      const dir = makeRepo();
      const failing = `printf '<testsuite><testcase file="tests/a.test.js" name="ok"/><testcase file="tests/a.test.js" name="broken"><failure message="nope"/></testcase></testsuite>' > report.xml`;
      const pid = await project(await flow(codingFlow()), { projectRoot: dir, verifyCommand: 'exit 0', testReport: { format: 'junit-xml', command: failing, reportPath: 'report.xml' } });
      const id = await card(pid, 'MAKE');
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'suite-green')).toMatchObject({ outcome: 'fail' });
      expect(byId(res.body.checks, 'suite-green').detail).toMatch(/broken/);
    });

    it('a step whose checks need no test results runs no suite', async () => {
      const dir = makeRepo();
      const marker = path.join(dir, 'ran');
      const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('END', 2, { isAnchor: true })]), { projectRoot: dir, verifyCommand: `touch ${marker}` });
      const id = await card(pid, 'START');
      expect((await validate(id)).status).toBe(200);
      expect(fs.existsSync(marker)).toBe(false);
      expect((await item(id)).stepRecords.filter((r: any) => r.kind === 'capture')).toEqual([]);
    });

    it('built-ins whose record no earlier step produces are reported not applicable, and do not block', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir, verifyCommand: 'exit 0' }), 'MAKE');
      const res = await validate(id);
      expect(res.status).toBe(200);
      const redSet = byId((await item(id)).lastChecks.results, 'red-set-passes-by-name');
      expect(redSet).toMatchObject({ outcome: 'n/a' });
      expect(redSet.detail).toMatch(/redSet/);
    });

    it('captures on the way OUT of a step when the next step needs its entry record', async () => {
      const dir = makeRepo();
      const f = await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('BUILD', 2, { role: 'planning', checks: [{ id: 'test-count-not-lower' }] }), s('END', 3, { isAnchor: true })]);
      const pid = await project(f, { projectRoot: dir, verifyCommand: 'exit 0', testReport: { format: 'junit-xml', command: junitCommand(2), reportPath: 'report.xml' } });
      const id = await card(pid, 'PLAN');
      expect((await validate(id)).status).toBe(200);
      const caps = (await item(id)).stepRecords.filter((r: any) => r.kind === 'capture');
      expect(caps).toHaveLength(1);
      expect(caps[0].step).toBe('PLAN');
      expect(caps[0].tests).toHaveLength(2);
    });

    it('test-count-not-lower compares against the entry record: fewer tests blocks', async () => {
      const dir = makeRepo();
      const f = await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('BUILD', 2, { role: 'planning', checks: [{ id: 'test-count-not-lower' }] }), s('END', 3, { isAnchor: true })]);
      const pid = await project(f, { projectRoot: dir, verifyCommand: 'exit 0', testReport: { format: 'junit-xml', command: junitCommand(3), reportPath: 'report.xml' } });
      const id = await card(pid, 'PLAN');
      expect((await validate(id)).status).toBe(200);
      await agent().put(`/projects/${pid}/test-report`).set(internal()).send({ format: 'junit-xml', command: junitCommand(2), reportPath: 'report.xml' });
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'test-count-not-lower')).toMatchObject({ outcome: 'fail' });
      expect(byId(res.body.checks, 'test-count-not-lower').detail).toMatch(/3.*2/);
    });

    it('a card with no entry record (it predates checks) gets a warning, never a pass or a block', async () => {
      const dir = makeRepo();
      const f = await flow([s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }), s('BUILD', 2, { role: 'planning', checks: [{ id: 'test-count-not-lower' }] }), s('END', 3, { isAnchor: true })]);
      const pid = await project(f, { projectRoot: dir, verifyCommand: 'exit 0', testReport: { format: 'junit-xml', command: junitCommand(1), reportPath: 'report.xml' } });
      const id = await card(pid, 'BUILD');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const r = byId((await item(id)).lastChecks.results, 'test-count-not-lower');
      expect(r.outcome).toBe('unavailable');
      expect(r.blocking).toBe(false);
      expect(r.detail).toMatch(/predates|entry/i);
    });

    it('async verify answers 202 at once and runs the checks in the background run', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir, verifyCommand: 'sleep 1; exit 4' }), 'MAKE');
      const started = Date.now();
      const res = await validate(id, { async: true });
      expect(res.status).toBe(202);
      expect(Date.now() - started).toBeLessThan(900);
      let run: any;
      for (let i = 0; i < 100; i++) {
        run = (await agent().get(`/items/validate-runs/${res.body.runId}`).set(internal())).body;
        if (run.status !== 'running') break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(run.status).toBe('failed');
      expect(run.message).toMatch(/suite-green/);
      expect(byId(run.checks, 'suite-green').outcome).toBe('fail');
      expect((await item(id)).status).toBe('MAKE');
    });

    it('async verify whose checks pass continues into the step transition', async () => {
      const dir = makeRepo();
      const id = await card(await project(await flow(codingFlow()), { projectRoot: dir, verifyCommand: 'exit 0' }), 'MAKE');
      const res = await validate(id, { async: true });
      expect(res.status).toBe(202);
      let run: any;
      for (let i = 0; i < 100; i++) {
        run = (await agent().get(`/items/validate-runs/${res.body.runId}`).set(internal())).body;
        if (run.status !== 'running') break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(run.status, JSON.stringify(run)).toBe('passed');
      expect((await item(id)).status).toBe('CHECK');
    });
  });

  it('after a slow gate, the final command still streams its output into the run', async () => {
    const dir = makeRepo();
    const steps = [s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('END', 2, { isAnchor: true, role: 'closing' })];
    const pid = await project(await flow(steps), { projectRoot: dir, verifyCommand: 'echo hello-stream; sleep 2; exit 0', testReport: { format: 'junit-xml', command: junitCommand(1), reportPath: 'report.xml' } });
    const id = await card(pid, 'MAKE');
    const res = await validate(id, { async: true });
    expect(res.status).toBe(202);
    let seenLive = false;
    let run: any;
    for (let i = 0; i < 100; i++) {
      run = (await agent().get(`/items/validate-runs/${res.body.runId}`).set(internal())).body;
      if (run.status === 'running' && String(run.output).includes('hello-stream')) seenLive = true;
      if (run.status !== 'running') break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(run.status, JSON.stringify(run)).toBe('passed');
    expect(seenLive).toBe(true);
  });

  it('lastChecks cannot be written through PUT /items/:id', async () => {
    const id = await card(await project(null), 'TODO');
    await agent().put(`/items/${id}`).send({ lastChecks: { step: 'TODO', at: 'x', results: [{ id: 'tree-clean', outcome: 'pass' }] } });
    expect((await item(id)).lastChecks).toBeUndefined();
  });
});
