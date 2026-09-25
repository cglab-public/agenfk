/**
 * @file 961f301d — a person waiting on the board must not wait on the suite.
 *
 * (2) APPROVAL FIRST: when a step still needs a person's approval, verify is
 * refused at once, before any capture or command check runs. Nothing it could
 * learn from them lets the card go, and the person is not shown the card until
 * the refusal comes back. The re-verify after the approval runs them.
 *
 * (3) REUSED ENTRY BASELINE: leaving a step into one whose checks read the
 * entry record used to run the whole suite to record it. When the tree is
 * clean at a commit a green run of the same command was recorded against (the
 * commit a close stamps on its test record), that green IS the baseline; the
 * suite runs only otherwise.
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

const TEST_DB = path.resolve('./approval-first-baseline-test-db.sqlite');
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
const board = () => ({ 'x-agenfk-ui': '1' });
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/**
 * START -> PLAN (a person's go-ahead, the suite, plus `planChecks`) -> TESTS -> END.
 * PLAN's suite-green makes leaving it capture - the capture the reuse is about.
 * (A step whose checks read a PER-TEST entry baseline is held earlier on a
 * project without a test report, 5a8d22e6; that is tested there.) The verify command appends a line to a file OUTSIDE
 * the repository, so every run is counted and none dirties the tree.
 */
async function setup(planChecks: unknown[] = []) {
  const f = await agent().post('/flows').send({ name: `af-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }),
    s('PLAN', 1, { role: 'planning', checks: [{ id: 'human-approval' }, { id: 'suite-green' }, ...planChecks] }),
    s('TESTS', 2, { role: 'planning' }),
    s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-af-repo-');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
  const runs = path.join(tmp('agenfk-af-runs-'), 'runs');
  const verifyCommand = `echo run >> ${runs}`;
  const p = await agent().post('/projects').send({ name: `af-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `af-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
  return { id: c.body.id as string, pid: p.body.id as string, repo, verifyCommand, runCount: () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0) };
}

/** A closed card in the project whose green run of `command` was recorded against `commit`. */
async function closedGreen(pid: string, command: string, commit: string, commitRoot?: string) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `af-done-${++seq}`, projectId: pid });
  const root = commitRoot ?? (await storage.getProject(pid) as any).projectRoot;
  await storage.updateItem(c.body.id, { status: 'DONE', tests: [{ id: `t-${seq}`, command, output: '', status: 'PASSED', executedAt: new Date(), commit, commitRoot: root }] } as any);
  return c.body.id as string;
}

const validate = (id: string, body: Record<string, unknown> = {}) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...body });
const approve = (id: string) => agent().post(`/items/${id}/approvals`).set(board()).send({});
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
const blockingIds = (checks: any[]) => (checks ?? []).filter((c: any) => c.blocking).map((c: any) => c.id);
const entryCapture = async (id: string) => ((await item(id)).stepRecords ?? []).filter((r: any) => r.kind === 'capture' && r.step === 'PLAN').pop();

describe('961f301d (2): a missing approval is answered first', () => {
  it('refuses at once, before capturing the entry baseline, with only the approval blocking', async () => {
    const t = await setup();
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(blockingIds(res.body.checks)).toEqual(['human-approval']);
    expect(t.runCount()).toBe(0);
    expect((await item(t.id)).status).toBe('PLAN');
  });

  it('answers an async verify with the refusal itself, not a background run (the CLI opens the card at once)', async () => {
    const t = await setup();
    const res = await validate(t.id, { async: true });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.runId).toBeUndefined();
    expect(blockingIds(res.body.checks)).toEqual(['human-approval']);
    expect(t.runCount()).toBe(0);
  });

  it('does not run the step\'s command checks while the approval is missing', async () => {
    const marker = path.join(tmp('agenfk-af-cmd-'), 'ran');
    const t = await setup([{ id: 'command-check', params: { name: 'lint', argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } }]);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(blockingIds(res.body.checks)).toEqual(['human-approval']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('still judges the cheap checks, so a person can see and override them while approving; slow ones are deferred', async () => {
    const t = await setup([{ id: 'jira-key-valid' }]);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(blockingIds(res.body.checks).sort()).toEqual(['human-approval', 'jira-key-valid']);
    expect((res.body.checks as any[]).find(c => c.id === 'suite-green')).toMatchObject({ outcome: 'deferred', blocking: false });
    expect(t.runCount()).toBe(0);
  });

  it('runs the capture on the verify after the approval', async () => {
    const t = await setup();
    expect((await validate(t.id)).status).toBe(422);
    expect((await approve(t.id)).status).toBe(201);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await item(t.id)).status).toBe('TESTS');
    expect(t.runCount()).toBe(1);
  });
});

describe('961f301d (3): the entry baseline reuses a recorded green', () => {
  it('reuses a green of the same command recorded at the clean HEAD: no suite runs', async () => {
    const t = await setup();
    const head = git(t.repo, 'git rev-parse HEAD');
    const from = await closedGreen(t.pid, t.verifyCommand, head);
    expect((await approve(t.id)).status).toBe(201);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(t.runCount()).toBe(0);
    const entry = await entryCapture(t.id);
    expect(entry).toMatchObject({ head, clean: true, exitCode: 0, reusedFrom: { itemId: from } });
  });

  it('captures when the tree is dirty: uncommitted work is content that green never saw', async () => {
    const t = await setup();
    await closedGreen(t.pid, t.verifyCommand, git(t.repo, 'git rev-parse HEAD'));
    fs.writeFileSync(path.join(t.repo, 'b'), 'dirty');
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
    expect((await entryCapture(t.id))?.reusedFrom).toBeUndefined();
  });

  it('captures when HEAD moved since the green was recorded', async () => {
    const t = await setup();
    const old = git(t.repo, 'git rev-parse HEAD');
    await closedGreen(t.pid, t.verifyCommand, old);
    git(t.repo, 'echo c > c && git add c && git commit -qm two');
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
    expect((await entryCapture(t.id))?.reusedFrom).toBeUndefined();
  });

  it('captures when the recorded green ran a different command', async () => {
    const t = await setup();
    await closedGreen(t.pid, 'true', git(t.repo, 'git rev-parse HEAD'));
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
  });

  it('captures when the green belongs to another project', async () => {
    const t = await setup();
    const other = await setup();
    await closedGreen(other.pid, t.verifyCommand, git(t.repo, 'git rev-parse HEAD'));
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
  });
});

describe('961f301d review: reuse stays in its own tree, and is judged per test when a report is set', () => {
  it('does not reuse a green recorded by a card in ANOTHER checkout at the same commit (CGLAB-366)', async () => {
    const t = await setup();
    const head = git(t.repo, 'git rev-parse HEAD');
    const other = tmp('agenfk-af-wt-');
    git(other, `git clone -q ${t.repo} .`);
    await closedGreen(t.pid, t.verifyCommand, head, other);
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
    expect((await entryCapture(t.id))?.reusedFrom).toBeUndefined();
  });

  /** A project whose report command writes a junit report (git-ignored) and counts its runs outside the tree. */
  async function withReport(exitCode = 0, surface?: string[]) {
    const t = await setup();
    git(t.repo, 'echo report.xml > .gitignore && git add .gitignore && git commit -qm ignore');
    const runs = path.join(tmp('agenfk-af-rep-'), 'runs');
    const runner = path.join(path.dirname(runs), 'runner.js');
    fs.writeFileSync(runner, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="adds numbers" file="t.test.js"/></testsuite></testsuites>');
process.exit(${exitCode});`);
    await storage.updateProject(t.pid, { testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml', ...(surface ? { surface } : {}) } } as never);
    const count = () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
    const second = async () => {
      const c = await agent().post('/items').send({ type: 'TASK', title: `af-b-${++seq}`, projectId: t.pid });
      await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
      return c.body.id as string;
    };
    return { ...t, count, second };
  }

  it('reuses an earlier per-test capture at the same clean commit, tests and all', async () => {
    const t = await withReport();
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.count()).toBe(1);
    const b = await t.second();
    expect((await approve(b)).status).toBe(201);
    expect((await validate(b)).status).toBe(200);
    expect(t.count()).toBe(1);
    const entry = await entryCapture(b);
    expect(entry).toMatchObject({ available: true, exitCode: 0, reusedFrom: { itemId: t.id } });
    expect(entry.tests.map((x: any) => x.name)).toEqual(expect.arrayContaining([expect.stringContaining('adds numbers')]));
  });

  it('captures when the recorded run exited non-zero: only a green is reused', async () => {
    const t = await withReport(1);
    expect((await approve(t.id)).status).toBe(201);
    await validate(t.id);
    const b = await t.second();
    expect((await approve(b)).status).toBe(201);
    await validate(b);
    expect(t.count()).toBe(2);
  });

  it('captures when the report command changed since, at the same commit', async () => {
    const t = await withReport();
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    const project: any = await storage.getProject(t.pid);
    await storage.updateProject(t.pid, { testReport: { ...project.testReport, command: `${project.testReport.command} --changed` } } as never);
    const b = await t.second();
    expect((await approve(b)).status).toBe(201);
    await validate(b);
    expect(t.count()).toBe(2);
  });

  /** Per-test captures written before the server first looked at the project: found by the scan, not by noteGreen. */
  async function scanned(recordRoot: (t: { repo: string }) => string) {
    const t = await withReport();
    const head = git(t.repo, 'git rev-parse HEAD');
    const project: any = await storage.getProject(t.pid);
    const c = await agent().post('/items').send({ type: 'TASK', title: `af-scan-${++seq}`, projectId: t.pid });
    await storage.updateItem(c.body.id, { status: 'DONE', stepRecords: [{
      step: 'PLAN', kind: 'capture', at: new Date().toISOString(), head, clean: true, root: recordRoot(t), command: project.testReport.command,
      format: 'junit-xml', available: true, exitCode: 0, tests: [{ name: 'adds numbers', file: 't.test.js', status: 'passed' }],
      brokenFiles: [], surface: { files: {} }, surfaceComplete: true, surfaceScope: 'declared', surfaceDeclared: [],
    }] } as any);
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    return { ...t, from: c.body.id as string };
  }

  it('the scan finds a per-test green recorded in this tree', async () => {
    const t = await scanned(t => t.repo);
    expect(t.count()).toBe(0);
    expect((await entryCapture(t.id))?.reusedFrom).toMatchObject({ itemId: t.from });
  });

  it('the scan ignores a per-test green recorded in another tree', async () => {
    const t = await scanned(() => '/somewhere/else');
    expect(t.count()).toBe(1);
  });

  it('captures when the declared test surface changed since', async () => {
    const t = await withReport();
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    const project: any = await storage.getProject(t.pid);
    await storage.updateProject(t.pid, { testReport: { ...project.testReport, surface: ['t.test.js'] } } as never);
    const b = await t.second();
    expect((await approve(b)).status).toBe(201);
    await validate(b);
    expect(t.count()).toBe(2);
  });
});

describe('961f301d review 2: a green belongs to the tree it ran in', () => {
  it('a green whose card has since moved to this tree is still not this tree\'s (after a restart the card\'s tree is no evidence)', async () => {
    const t = await setup();
    const head = git(t.repo, 'git rev-parse HEAD');
    const other = tmp('agenfk-af-wt2-');
    git(other, `git clone -q ${t.repo} .`);
    // Recorded in `other`; the card itself now resolves to the project root (its worktree was removed).
    await closedGreen(t.pid, t.verifyCommand, head, other);
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
  });

  it('a green recorded before checks named its tree never qualifies', async () => {
    const t = await setup();
    const c = await agent().post('/items').send({ type: 'TASK', title: `af-old-${++seq}`, projectId: t.pid });
    await storage.updateItem(c.body.id, { status: 'DONE', tests: [{ id: 'old', command: t.verifyCommand, output: '', status: 'PASSED', executedAt: new Date(), commit: git(t.repo, 'git rev-parse HEAD') }] } as any);
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
  });

  it('a close\'s green, recorded AFTER the project was indexed, is reused by the next card', async () => {
    const t = await setup();
    // 1. The first capture indexes the project (nothing to reuse yet).
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    expect(t.runCount()).toBe(1);
    // 2. A card closes through verify: its green is stamped with the clean commit.
    const closing = await agent().post('/items').send({ type: 'TASK', title: `af-close-${++seq}`, projectId: t.pid });
    await storage.updateItem(closing.body.id, { status: 'TESTS' } as any);
    const done = await validate(closing.body.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await item(closing.body.id)).tests.find((x: any) => x.commit)).toBeDefined();
    const runsAfterClose = t.runCount();
    // 3. The next card at that commit reuses it.
    const next = await agent().post('/items').send({ type: 'TASK', title: `af-next-${++seq}`, projectId: t.pid });
    await storage.updateItem(next.body.id, { status: 'PLAN' } as any);
    expect((await approve(next.body.id)).status).toBe(201);
    expect((await validate(next.body.id)).status).toBe(200);
    expect(t.runCount()).toBe(runsAfterClose);
    expect((await entryCapture(next.body.id))?.reusedFrom).toMatchObject({ itemId: closing.body.id });
  });
});

describe('961f301d review 2: an overridden approval is not waited on', () => {
  it('after a person overrides the approval, verify runs the checks once and advances', async () => {
    const t = await setup();
    expect((await validate(t.id)).status).toBe(422);
    const o = await agent().post(`/items/${t.id}/overrides`).set(board()).send({ checkId: 'human-approval', reason: 'spike: no approval needed' });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // One refusal, one pass: the pass did not first run a person-first gate as well.
    expect(((await item(t.id)).checkHistory ?? []).filter((h: any) => h.kind === 'verify' && h.step === 'PLAN')).toHaveLength(2);
    expect(t.runCount()).toBe(1);
  });
});

describe('961f301d review: a verify that waits on nobody is judged once', () => {
  it('an approved step records one check history entry per verify, not a person-first one too', async () => {
    const t = await setup();
    expect((await approve(t.id)).status).toBe(201);
    expect((await validate(t.id)).status).toBe(200);
    const history = ((await item(t.id)).checkHistory ?? []).filter((h: any) => h.kind === 'verify' && h.step === 'PLAN');
    expect(history).toHaveLength(1);
  });

  it('an approval given at the parent counts: no person-first refusal, one history entry', async () => {
    const t = await setup();
    const parent = await agent().post('/items').send({ type: 'STORY', title: `af-parent-${++seq}`, projectId: t.pid });
    await storage.updateItem(parent.body.id, { status: 'PLAN' } as any);
    await storage.updateItem(t.id, { parentId: parent.body.id } as any);
    expect((await approve(parent.body.id)).status).toBe(201);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(((await item(t.id)).checkHistory ?? []).filter((h: any) => h.kind === 'verify' && h.step === 'PLAN')).toHaveLength(1);
  });

  it('a warn-severity approval never holds the card, and is judged once', async () => {
    const f = await agent().post('/flows').send({ name: `af-warn-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'human-approval', severity: 'warn' }] }), s('TESTS', 2), s('END', 3, { isAnchor: true }),
    ] });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const repo = tmp('agenfk-af-warn-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
    const p = await agent().post('/projects').send({ name: `af-warn-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true' } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: `af-warn-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
    expect((await validate(c.body.id)).status).toBe(200);
    expect(((await item(c.body.id)).checkHistory ?? []).filter((h: any) => h.kind === 'verify' && h.step === 'PLAN')).toHaveLength(1);
  });
});
