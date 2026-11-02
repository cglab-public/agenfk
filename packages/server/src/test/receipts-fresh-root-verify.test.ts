/**
 * @file RFC-002 (task f918a42c) - in receipts mode the root card's final gate
 * RUNS the verify command, even when a green of this very tree is already on
 * record, and the passing run leaves a verification receipt on the card.
 *
 * close-green-on-record.test.ts (ef1342b8) is the opposite promise: a green of
 * this tree's content, by this very command, in this very root, stands for the
 * verify command, and the card closes on it. That is right while a green is a
 * local convenience. It stops being right the moment a green is a RECEIPT a CI
 * job and another machine have to honour: a card that closes on somebody
 * else's earlier run has proven nothing about the tree it closed on, and there
 * is no run to write a receipt for. So in receipts mode a ROOT card's final
 * gate runs the command, the prediction says so, and the pass is stamped into
 * `verificationReceipts`.
 *
 * The two controls are the point as much as the feature: with receiptsMode
 * 'off' the same card still closes on the green on record, and a CHILD card in
 * receipts mode still reuses it (receipts are made by the card that runs the
 * suite, and a child that defers to its parent runs none). The receipt itself
 * is checked field by field, because it is what leaves this machine, and it is
 * checked as ABSENT when the tree moved during the run, when the run failed,
 * and when the project is not in receipts mode at all.
 *
 * The harness is the one close-green-on-record.test.ts uses: the real app, a
 * git repository per test, and a suite command that counts its own runs in a
 * log outside the tree.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('receipts-fresh-root-verify-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { posixShell } from './helpers/posixShell';
import { nodeCommand } from './helpers/nodeCommand';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: posixShell() });

function makeRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-'));
  dirs.push(dir);
  git(dir, 'git init -q -b main && git config user.email t@t && git config user.name t');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git(dir, 'git add . && git commit -qm one');
  return dir;
}

/** A suite writing a JUnit report of two passing tests, counting its runs in a log outside the tree. */
// Node, not printf/echo: the server runs it with sh off Windows and cmd.exe on it (#208).
const JUNIT_JS = `require('fs').writeFileSync('report.xml', '<testsuite><testcase file="tests/a.test.js" name="t0"/><testcase file="tests/a.test.js" name="t1"/></testsuite>');`;
function counted(tag: string) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-log-')), 'runs');
  dirs.push(path.dirname(log));
  const command = nodeCommand(`require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${tag}\n`)});${JUNIT_JS}`);
  return { command, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

/**
 * A suite that DIRTS THE TREE it is being asked to certify. On every run after
 * its first it appends a line to tracked code - uncommitted, deliberately - and
 * then passes. The tree it tested and the tree the card closes on are two
 * different trees, HEAD never moved, and the close commits nothing in the test
 * environment: exactly one guard can fail, the "the files did not change during
 * the run" one, and it can only fail for that reason. No receipt can be made of
 * that run - which is the whole point of a guard that reads the tree twice.
 *
 * Every run takes its report back out of the tree when it is done with it (it is
 * what the run writes, not what it tested), so no capture is ever read as a green
 * and no green is ever on record for a tree. The card can close on nothing but
 * the command the final gate runs there itself: the run a receipt would be made
 * from, and the one the dirty tree refuses.
 *
 * The script sits in the repository it tests and holds absolute paths only, so
 * the command is one short repo-relative string like a real `npm test`, and the
 * file it removes is removed from the tree it just read.
 */
function countedThenTreeDirtier(files: Record<string, string> = {}): { dir: string; command: string; runs: () => string[] } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-log-')));
  dirs.push(dir);
  const log = path.join(dir, 'runs');
  const stored = path.join(dir, 'report.xml');
  const moved = JSON.stringify('// touched by the run' + String.fromCharCode(10));
  const NL = JSON.stringify(String.fromCharCode(10));
  const source = `const fs=require('fs');`
    + `const seen=fs.existsSync(${JSON.stringify(log)})?fs.readFileSync(${JSON.stringify(log)},'utf8').split(${NL}).filter(Boolean).length:0;`
    + `if(seen)fs.appendFileSync('src.js',${moved});`
    + `fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify('suite' + String.fromCharCode(10))});`
    + JUNIT_JS
    + `fs.copyFileSync('report.xml',${JSON.stringify(stored)});fs.rmSync('report.xml',{force:true});`;
  return {
    dir: makeRepo({ 'scripts/suite.cjs': source, ...files }),
    command: 'node scripts/suite.cjs',
    runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(String.fromCharCode(10)).filter(Boolean) : []),
  };
}

/** A suite that writes a green report and then fails: the close must not stand, and is recorded red. */
function countedButFailing(tag: string) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-log-')), 'runs');
  dirs.push(path.dirname(log));
  const command = nodeCommand(`require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${tag}\n`)});${JUNIT_JS}process.exit(1);`);
  return { command, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function flow(steps: any[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent().post('/flows').send({ name: `receipts-${++seq}`, steps, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
async function project(flowId: string, extra: Record<string, unknown>) {
  const p = await agent().post('/projects').send({ name: `receipts-${++seq}` });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await storage.updateProject(p.body.id, { flowId, ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
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
const finalOnly = (extra: Record<string, unknown> = {}) => flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('FINAL', 2), s('END', 3, { isAnchor: true, role: 'closing' })], extra);
const reported = (dir: string, command: string) => ({ projectRoot: dir, verifyCommand: command, testReport: { format: 'junit-xml', reportPath: 'report.xml', command } });

/**
 * The hub's settings for the repository, as the sync would have stored them
 * (task 07bf292e) - with this repository's receipts mode. The hub's command IS
 * the suite command, so the hub authority of task 1 runs the very command this
 * test counts, and there is no second command to tell it apart from.
 */
const hub = (verifyCommand: string, receiptsMode: 'off' | 'shadow' | 'enforce') => ({
  remoteUrl: 'git@github.com:acme/app.git',
  verifyCommand,
  revision: 4,
  receiptsMode,
  shadowThreshold: null,
  producers: [],
  syncedAt: new Date().toISOString(),
});
const inReceiptsMode = (pid: string, command: string, receiptsMode: 'off' | 'shadow' | 'enforce') =>
  storage.updateProject(pid, { hubRepoSettings: hub(command, receiptsMode) } as never);

const receiptsOf = (item: any): any[] => (item?.verificationReceipts ?? []) as any[];
const commentsOf = (item: any): any[] => (item?.comments ?? []) as any[];
// An argv, not a shell string: cmd.exe on Windows reads `^` as its escape and git got `HEAD{tree}`.
const revParse = (dir: string, ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf8' }).trim();

describe('in receipts mode the root card final gate runs the command, and the pass is a receipt (RFC-002 f918a42c)', () => {
  it('shadow: a green of this tree on record does not close a root card - the command runs and the plan says so', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'FINAL');
    expect(suite.runs(), 'the step capture should have run the suite once').toHaveLength(1);

    const p = await predict(id);
    expect(p.mode, JSON.stringify(p)).toBe('full');
    expect(p.advice, JSON.stringify(p)).toMatch(/would run/);

    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('END');
    expect(suite.runs(), 'the close closed on a green on record instead of running the command').toHaveLength(2);
  });

  it('CONTROL - receipts mode off: the close still stands on the green on record, nothing is run again, and no receipt is made', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'off');
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'FINAL');
    expect(suite.runs()).toHaveLength(1);

    expect((await predict(id)).mode).toBe('reuse');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'receipts mode off re-ran the verify command the close used to skip').toHaveLength(1);
    expect(res.body.message).toMatch(/green of this tree on record/);
    expect(receiptsOf(await read(id)), 'a receipt outside receipts mode').toHaveLength(0);
  });

  it('CONTROL - a child card in shadow mode keeps the reuse: the plan says reuse and the command does not run again', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    // verifyAt 'leaf' (the default): the child closes on its own verify, so the
    // only thing left to test is whether it reuses the green.
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');

    const parent = await agent().post('/items').send({ type: 'STORY', title: `parent-${++seq}`, projectId: pid });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    await storage.updateItem(parent.body.id, { status: 'WORK' } as any);

    const id = await card(pid, 'WORK');
    await storage.updateItem(id, { parentId: parent.body.id } as any);
    await captureNow(id);
    await moveTo(id, 'FINAL');
    expect(suite.runs()).toHaveLength(1);

    const p = await predict(id);
    expect(p.mode, JSON.stringify(p)).toBe('reuse');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'a child card lost the reuse that receipts mode keeps for it').toHaveLength(1);
  });

  it('the passing run leaves one verification receipt naming the repo, the command, the card and the tree', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');
    const id = await card(pid, 'WORK');
    await agent().put(`/items/${id}`).send({ title: 'card-of-this-test' });
    await captureNow(id);
    await moveTo(id, 'FINAL');
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs()).toHaveLength(2);

    const receipts = receiptsOf(await read(id));
    expect(receipts, JSON.stringify(receipts)).toHaveLength(1);
    expect(receipts[0].kind).toBe('verification');
    expect(receipts[0].version).toBe(1);
    expect(receipts[0].repo).toBe('git@github.com:acme/app.git');
    expect(receipts[0].receiptsMode).toBe('shadow');
    expect(receipts[0].reusable).toBe(true);
    expect(receipts[0].execution.command).toBe(suite.command);
    expect(receipts[0].execution.commandRevision).toBe(4);
    expect(receipts[0].execution.exitCode).toBe(0);
    expect(receipts[0].card.title).toBe('card-of-this-test');
    // git config of the run root, through resolveActor.
    expect(receipts[0].card.closedBy.email).toBe('t@t');
    // The tree a CI job recomputes the identity of on its own checkout.
    expect(receipts[0].content.commit).toBe(revParse(dir, 'HEAD'));
    expect(receipts[0].content.gitTree).toBe(revParse(dir, 'HEAD^{tree}'));
    expect(receipts[0].content.treeStateVersion).toEqual(expect.any(Number));
    // Every field the shape promises is THERE, because the receipt leaves this
    // machine: a CI job and another clone read it without asking us anything.
    expect(receipts[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipts[0].card.id).toBe(id);
    expect(receipts[0].card.closedAt).toEqual(expect.any(String));
    expect(new Date(receipts[0].card.closedAt).getTime()).not.toBeNaN();
    expect(receipts[0].card.owner).toBeNull();
    expect(typeof receipts[0].card.closedBy.name).toBe('string');
    expect(receipts[0].card.link).toBeNull();
    expect(receipts[0].execution.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(receipts[0].execution.startedAt).getTime()).not.toBeNaN();
    expect(new Date(receipts[0].execution.finishedAt).getTime()).toBeGreaterThanOrEqual(new Date(receipts[0].execution.startedAt).getTime());
    // The receipt points at a run the card itself has a PASSED record of, not at
    // a run it only means to have done.
    const green = ((await read(id)).tests ?? []).find((t: any) => t.status === 'PASSED' && t.id === receipts[0].execution.id);
    expect(green, 'the receipt points at a run the card has no record of').toBeTruthy();
    expect(typeof receipts[0].execution.logPath === 'string' || receipts[0].execution.logPath === null).toBe(true);
    expect(receipts[0].content.treeState === null || typeof receipts[0].content.treeState === 'string').toBe(true);
  });

  it('the run left the tree it was proving dirty: the card may close, but no receipt is made and the card says so', async () => {
    // The card writes no tracked file of its own: every change to tracked code
    // here is the RUN's, so "the tree changed during the run" can only mean the
    // run changed it.
    const suite = countedThenTreeDirtier();
    const pid = await project(await finalOnly(), reported(suite.dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');
    const id = await card(pid, 'WORK');
    await captureNow(id);
    expect(suite.runs(), 'the step capture should have run the suite once').toHaveLength(1);
    await moveTo(id, 'FINAL');

    const res = await validate(id);
    // Today's behaviour: a tree the run moved does not refuse the close. Only
    // the receipt - a claim for others to honour - it forbids.
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'the close ran nothing, so the tree it closed on was never tested').toHaveLength(2);
    const item = await read(id);
    // Not a receipt's worth of proof, and the card is told so in one sentence.
    expect(receiptsOf(item), JSON.stringify(receiptsOf(item))).toHaveLength(0);
    expect(commentsOf(item).some((c: any) => /receipt/i.test(String(c?.content ?? ''))),
      'the card says nothing about the receipt the run did not earn').toBe(true);
  });

  // Codex review of RFC-002: a project in a SUBDIRECTORY of the repository. The
  // receipt names the whole repository's tree, so a change beside the project
  // that lands during the close (here a pre-commit hook staging a sibling
  // package) is content no run tested. Posix only: the hook is a shell script.
  const subdirProject = async (withHook: boolean) => {
    const dir = makeRepo({ 'app/tests/a.test.js': 'test', 'app/src.js': 'export const a = 1;\n', 'app/.gitignore': 'report.*\n', 'sibling/x.txt': 'one\n' });
    if (withHook) {
      const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, '#!/bin/sh\necho hooked >> sibling/x.txt && git add sibling/x.txt\n', { mode: 0o755 });
    }
    const app = path.join(dir, 'app');
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(app, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');
    const id = await card(pid, 'FINAL');
    // Staged work of the card's own, so the close makes a commit (and the hook runs).
    fs.writeFileSync(path.join(app, 'src.js'), 'export const a = 2;\n');
    git(dir, 'git add app/src.js');
    return { dir, id };
  };
  /**
   * The close commit is switched off under Vitest (server.ts reads NODE_ENV and
   * VITEST when the close runs). These two tests are ABOUT what lands in that
   * commit, so they lift the switch for the one validate and put it back.
   */
  const validateWithCloseCommit = async (id: string) => {
    const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
    delete process.env.NODE_ENV; delete process.env.VITEST;
    try { return await validate(id); } finally {
      if (saved.NODE_ENV !== undefined) process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.VITEST !== undefined) process.env.VITEST = saved.VITEST;
    }
  };

  it.skipIf(process.platform === 'win32')('CONTROL - a project in a subdirectory gets its receipt when nothing beside it moves', async () => {
    const { id } = await subdirProject(false);
    const res = await validateWithCloseCommit(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(receiptsOf(await read(id)), JSON.stringify(commentsOf(await read(id)).slice(-2))).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('no receipt when content beside a subdirectory project changed during the close', async () => {
    const { dir, id } = await subdirProject(true);
    const res = await validateWithCloseCommit(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    // The hook really did land its change in the commit the receipt would name.
    expect(fs.readFileSync(path.join(dir, 'sibling/x.txt'), 'utf8')).toContain('hooked');
    expect(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
    expect(receiptsOf(await read(id))).toHaveLength(0);
    expect(commentsOf(await read(id)).map((c: any) => c.content).join('\n')).toMatch(/No verification receipt/);
  });

  it('a failing run closes nothing and makes no receipt', async () => {
    const dir = makeRepo();
    const suite = countedButFailing('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');
    const id = await card(pid, 'WORK');
    await captureNow(id);
    await moveTo(id, 'FINAL');
    expect(suite.runs()).toHaveLength(1);

    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect((await storage.getItem(id))?.status).toBe('FINAL');
    expect(suite.runs()).toHaveLength(2);
    const item = await read(id);
    expect(receiptsOf(item), JSON.stringify(receiptsOf(item))).toHaveLength(0);
  });
});

/*
 * GH-291: two ROOT cards on one tree (one PR made of two cards). The second to
 * close found the first one's green and closed on it by sibling propagation -
 * running nothing, so it made no receipt, and the PR's content was certified by
 * nobody. In receipts mode a root card owes a fresh run whatever a sibling did.
 */
describe('in receipts mode a root card does not close on a sibling root card\'s green (GH-291)', () => {
  async function twoRootCardsOneTree(mode: 'off' | 'shadow' | 'enforce') {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, mode);
    const first = await card(pid, 'FINAL');
    const second = await card(pid, 'FINAL');
    const a = await validate(first);
    expect(a.body.status, JSON.stringify(a.body)).toBe('END');
    return { dir, suite, first, second };
  }

  for (const mode of ['shadow', 'enforce'] as const) {
    it(`${mode}: the second root card runs the command itself and leaves its own receipt`, async () => {
      const { dir, suite, second } = await twoRootCardsOneTree(mode);
      const before = suite.runs().length;
      const p = await predict(second);
      expect(p.mode, JSON.stringify(p)).toBe('full');
      const b = await validate(second);
      expect(b.body.status, JSON.stringify(b.body)).toBe('END');
      expect(b.body.message, 'closed on the sibling instead of running').not.toMatch(/sibling propagation|already verified by sibling/i);
      expect(suite.runs(), 'the second root card ran nothing').toHaveLength(before + 1);
      const receipts = receiptsOf(await read(second));
      expect(receipts, JSON.stringify(commentsOf(await read(second)).map(c => c.content).slice(-2))).toHaveLength(1);
      expect(receipts[0].content.gitTree).toBe(revParse(dir, 'HEAD^{tree}'));
    });
  }

  it('CONTROL - receipts mode off: the second root card still closes on the sibling\'s green, running nothing', async () => {
    const { suite, second } = await twoRootCardsOneTree('off');
    const before = suite.runs().length;
    expect((await predict(second)).mode).toBe('sibling-green');
    const b = await validate(second);
    expect(b.body.status, JSON.stringify(b.body)).toBe('END');
    expect(suite.runs()).toHaveLength(before);
    expect(receiptsOf(await read(second))).toHaveLength(0);
  });
});

// Review of GH-291 (Codex): the two other ways a root card closed without the fresh run it owes.
describe('in receipts mode a root parent is not closed by its last child (GH-291 review)', () => {
  async function storyWithOneTask(mode: 'off' | 'shadow') {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalOnly(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, mode);
    const parent = await agent().post('/items').send({ type: 'STORY', title: `story-${++seq}`, projectId: pid });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    await storage.updateItem(parent.body.id, { status: 'FINAL' } as any);
    const child = await card(pid, 'FINAL');
    await storage.updateItem(child, { parentId: parent.body.id } as any);
    const c = await validate(child);
    expect(c.body.status, JSON.stringify(c.body)).toBe('END');
    return { dir, suite, parent: parent.body.id as string };
  }

  it('shadow: the last child closing leaves the root parent on its final step; the parent\'s own verify runs fresh and makes the receipt', async () => {
    const { dir, suite, parent } = await storyWithOneTask('shadow');
    expect((await read(parent)).status, 'the parent was walked to the exit step having run nothing').toBe('FINAL');
    const before = suite.runs().length;
    expect((await predict(parent)).mode).toBe('full');
    const p = await validate(parent);
    expect(p.body.status, JSON.stringify(p.body)).toBe('END');
    expect(suite.runs()).toHaveLength(before + 1);
    const receipts = receiptsOf(await read(parent));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].content.gitTree).toBe(revParse(dir, 'HEAD^{tree}'));
  });

  it('CONTROL - receipts mode off: the last child closing still closes the parent', async () => {
    const { parent } = await storyWithOneTask('off');
    expect((await read(parent)).status).toBe('END');
  });
});

describe('in receipts mode the plan of a final step that captures says the command runs after the capture (GH-291 review)', () => {
  const finalCaptures = () => flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('TEST', 2, { role: 'testing' }), s('END', 3, { isAnchor: true, role: 'closing' })]);
  const plan = async (id: string) => {
    const r = await agent().get(`/items/${id}/leave-plan`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  it('shadow: the capture does not close the card, the verify command runs after it, and the plan says so', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalCaptures(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'shadow');
    const id = await card(pid, 'TEST');
    const p = await plan(id);
    expect(p.closesOnCapture, JSON.stringify(p)).toBeUndefined();
    expect(p.thenCommand).toBe(suite.command);
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs(), 'the plan and the close disagree about how many runs').toHaveLength(2);
  });

  it('CONTROL - receipts mode off: the capture closes the card in one run, as planned', async () => {
    const dir = makeRepo();
    const suite = counted('suite');
    const pid = await project(await finalCaptures(), reported(dir, suite.command));
    await inReceiptsMode(pid, suite.command, 'off');
    const id = await card(pid, 'TEST');
    expect((await plan(id)).closesOnCapture).toBe(true);
    const res = await validate(id);
    expect(res.body.status, JSON.stringify(res.body)).toBe('END');
    expect(suite.runs()).toHaveLength(1);
  });
});
