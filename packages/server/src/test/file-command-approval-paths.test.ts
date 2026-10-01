/**
 * 2a181a8d: a verifyCommand the repository declares (.agenfk/project.json)
 * runs only once a person here has approved it - on every path a verify can
 * take, and without spending a run it is going to refuse anyway.
 *
 * Gaps the review of the step gate left open, each pinned here:
 * - the background (202) path dropped the refusal's fingerprint and command;
 * - nothing showed the approved command actually running afterwards;
 * - on the final step, a stored test report's suite ran in full before the
 *   final check refused the file's command;
 * - a card whose suite is deferred to its open parent (verifyAt 'parent')
 *   runs nothing, and was refused anyway.
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

const TEST_DB = path.resolve('./file-command-approval-paths-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

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

/** A JUnit report of two passing tests, as a command. */
const JUNIT = `printf '<testsuite><testcase file="tests/a.test.js" name="t0"/><testcase file="tests/a.test.js" name="t1"/></testsuite>' > report.xml`;

/** A repository whose .agenfk/project.json declares `verifyCommand`. */
function repoDeclaring(verifyCommand: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-filecmd-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.mkdirSync(path.join(dir, '.agenfk'));
  fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'x', verifyCommand }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\nFILE_RAN\nREPORT_RAN\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function flow(steps: any[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent().post('/flows').send({ name: `filecmd-${++seq}`, steps, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string, extra: Record<string, unknown>) {
  const p = await agent().post('/projects').send({ name: `filecmd-${++seq}` });
  await storage.updateProject(p.body.id, { flowId, ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string, body: Record<string, unknown> = {}) =>
  agent().post(`/items/${id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'ok', ...body });

/** A verify that may answer 202: follows the run to its end, and returns what it recorded. */
async function validateFollowing(id: string): Promise<{ status: number; body: any }> {
  const r = await validate(id, { async: true });
  if (r.status !== 202) return { status: r.status, body: r.body };
  for (let i = 0; i < 800; i++) {
    const run = await agent().get(`/items/validate-runs/${r.body.runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (run.body.finishedAt) return { status: run.body.status === 'passed' ? 200 : 400, body: run.body };
    await new Promise(res => setTimeout(res, 25));
  }
  throw new Error('the run never finished');
}

/** A person approving it, from the board's own page. */
function approve(projectId: string, command: string) {
  const host = `127.0.0.1:${(__server.address() as import('net').AddressInfo).port}`;
  return agent().post(`/projects/${projectId}/approve-file-command`)
    .set('x-agenfk-ui', '1').set('Host', host).set('Origin', `http://${host}`)
    .send({ command });
}

const report = { format: 'junit-xml', reportPath: 'report.xml' };

describe('a repository command on every verify path', () => {
  it('in a background run: refused, with the fingerprint and command the caller needs, and never run', async () => {
    const command = `touch FILE_RAN && ${JUNIT}`;
    const dir = repoDeclaring(command);
    // A capture check on a step that is not the last: the verify goes to the background.
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('CHECK', 2), s('END', 3, { isAnchor: true })]), { projectRoot: dir, testReport: report });
    const id = await card(pid, 'WORK');
    const res = await validateFollowing(id);
    expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_NEEDS_APPROVAL');
    expect(res.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.command).toBe(command);
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(false);
  });

  it('once a person approves it, the same command runs', async () => {
    const command = `touch FILE_RAN && ${JUNIT}`;
    const dir = repoDeclaring(command);
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('CHECK', 2), s('END', 3, { isAnchor: true })]), { projectRoot: dir, testReport: report });
    expect((await approve(pid, command)).status).toBe(200);
    const id = await card(pid, 'WORK');
    const res = await validateFollowing(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(true);
    expect((await storage.getItem(id))?.status).toBe('CHECK');
  });

  it("on the final step: refused before the stored report's suite spends a run", async () => {
    const dir = repoDeclaring('echo from-the-file');
    // The STORED report command needs no approval and runs in the capture; the file's command gates the close.
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('END', 2, { isAnchor: true })]), {
      projectRoot: dir, testReport: { ...report, command: `touch REPORT_RAN && ${JUNIT}` },
    });
    const id = await card(pid, 'WORK');
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_NEEDS_APPROVAL');
    expect(fs.existsSync(path.join(dir, 'REPORT_RAN'))).toBe(false);
  });

  it('a card whose suite is deferred to its open parent closes without being asked: it runs nothing', async () => {
    const dir = repoDeclaring('echo from-the-file');
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })], { verifyAt: 'parent' }), { projectRoot: dir });
    const parent = await card(pid, 'WORK');
    const id = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deferred to the parent/i);
  });

  it("the leave plan says the close will be refused for approval - not that it runs the command 'for you'", async () => {
    const dir = repoDeclaring('echo plan-marker');
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })]), { projectRoot: dir });
    const id = await card(pid, 'WORK');
    const plan = await agent().get(`/items/${id}/leave-plan`);
    expect(plan.body.refuses, JSON.stringify(plan.body)).toBe('COMMAND_NEEDS_APPROVAL');
    expect(plan.body.advice).toMatch(/approves it on the board/);
    // It is refused, so it is not named as something to run.
    expect(plan.body.advice).not.toContain('plan-marker');
    const predicted = await agent().get(`/items/${id}/leave-plan?predict=1`);
    expect(predicted.body.prediction.mode).toBe('none');
  });
});
