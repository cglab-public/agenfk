/**
 * #260: a verifyCommand the repository declares (.agenfk/project.json) runs
 * like any other committed code, with no per-machine approval.
 *
 * The approval protected little: the stored command already runs whatever the
 * repository contains, an agent could still change the stored command with
 * `update-project`, and in the browser there was nowhere to give it. What
 * stays: a command holding characters a screen cannot show faithfully is
 * still refused, and a change to the declared command is written on the open
 * cards, as a change of the stored one already is.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
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

const TEST_DB = testDbPath('file-verify-command-no-approval-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN, unreadableFileVerify, observeDeclaredVerifyCommand } from '../server';
import { posixShell } from './helpers/posixShell';
import { nodeCommand } from './helpers/nodeCommand';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Node, not touch/printf: the server runs it with sh off Windows and cmd.exe on it (#208).
const JUNIT_JS = `require('fs').writeFileSync('report.xml', '<testsuite><testcase file="tests/a.test.js" name="t0"/><testcase file="tests/a.test.js" name="t1"/></testsuite>');`;
/** Leaves `marker` in the tree, then writes the report: proof the command really ran. */
const markThenReport = (marker: string) => nodeCommand(`require('fs').writeFileSync(${JSON.stringify(marker)}, '');${JUNIT_JS}`);
/** Only leaves `marker`: a plain verify command with no report. */
const mark = (marker: string) => nodeCommand(`require('fs').writeFileSync(${JSON.stringify(marker)}, '');`);

function writeDeclared(dir: string, verifyCommand: string) {
  fs.writeFileSync(path.join(dir, '.agenfk', 'project.json'), JSON.stringify({ verifyCommand }));
}

/** A repository whose .agenfk/project.json declares `verifyCommand`. */
function repoDeclaring(verifyCommand: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-noapproval-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: posixShell() });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.mkdirSync(path.join(dir, '.agenfk'));
  writeDeclared(dir, verifyCommand);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\nFILE_RAN\nFIRST_RAN\nSECOND_RAN\nREPORT_RAN\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  return dir;
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function flow(steps: any[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await agent().post('/flows').send({ name: `noapproval-${++seq}`, steps, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string, extra: Record<string, unknown>) {
  const p = await agent().post('/projects').send({ name: `noapproval-${++seq}` });
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

/** A verify that may answer 202: follows the run to its end. */
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

const commentsOf = async (id: string) => ((await storage.getItem(id)) as any)?.comments?.map((c: any) => String(c.content)).join('\n') ?? '';
const twoSteps = () => flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })]);

describe('a repository-declared verify command needs no approval (#260)', () => {
  it('runs at the close, and the card closes', async () => {
    const dir = repoDeclaring(mark('FILE_RAN'));
    const pid = await project(await twoSteps(), { projectRoot: dir });
    const id = await card(pid, 'WORK');
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(true);
    expect((await storage.getItem(id))?.status).toBe('END');
  });

  it('runs on the background path a capture check takes', async () => {
    const dir = repoDeclaring(markThenReport('FILE_RAN'));
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('CHECK', 2), s('END', 3, { isAnchor: true })]), {
      projectRoot: dir, testReport: { format: 'junit-xml', reportPath: 'report.xml' },
    });
    const id = await card(pid, 'WORK');
    const res = await validateFollowing(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(true);
    expect((await storage.getItem(id))?.status).toBe('CHECK');
  });

  it('is not predicted as an approval refusal by the leave plan', async () => {
    const dir = repoDeclaring(mark('FILE_RAN'));
    const pid = await project(await twoSteps(), { projectRoot: dir });
    const id = await card(pid, 'WORK');
    const res = await agent().get(`/items/${id}/leave-plan?predict=1`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.refuses).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('COMMAND_NEEDS_APPROVAL');
    expect(JSON.stringify(res.body)).not.toMatch(/nobody on this machine has approved/);
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(false);
  });

  it('is still refused when it holds characters a screen cannot show faithfully, and never runs', async () => {
    // U+202E (right-to-left override) makes the text read differently from what the shell runs.
    const dir = repoDeclaring(`${mark('FILE_RAN')} ‮`);
    const pid = await project(await twoSteps(), { projectRoot: dir });
    const id = await card(pid, 'WORK');
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_UNREADABLE');
    expect(String(res.body.message)).toContain('U+202E');
    expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(false);
    expect((await storage.getItem(id))?.status).toBe('WORK');
  });

  it('has no approve route any more', async () => {
    const pid = await project(await twoSteps(), {});
    const host = `127.0.0.1:${(__server.address() as import('net').AddressInfo).port}`;
    const res = await agent().post(`/projects/${pid}/approve-file-command`)
      .set('x-agenfk-ui', '1').set('Host', host).set('Origin', `http://${host}`)
      .send({ command: 'echo x' });
    expect(res.status).toBe(404);
  });

  it('writes a change of the declared command on the open cards, as a stored change already is', async () => {
    const first = mark('FIRST_RAN');
    const dir = repoDeclaring(first);
    const pid = await project(await twoSteps(), { projectRoot: dir });
    const closing = await card(pid, 'WORK');
    const bystander = await card(pid, 'WORK');

    // First sight of the declared command: it runs, and nothing is announced.
    expect((await validate(closing)).body.error).toBeUndefined();
    expect(await commentsOf(bystander)).not.toMatch(/verify command changed/i);

    const second = mark('SECOND_RAN');
    writeDeclared(dir, second);
    const res = await validate(bystander);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'SECOND_RAN'))).toBe(true);

    const notes = await commentsOf(bystander);
    expect(notes).toMatch(/Repository verify command changed/);
    expect(notes).toContain(first);
    expect(notes).toContain(second);
    // Recorded on the project too, as the stored command's changes are.
    const changes = ((await storage.getProject(pid)) as any).verifyCommandChanges ?? [];
    expect(changes.some((c: any) => c.from === first && c.to === second && c.source === 'file')).toBe(true);
  });

  it('a card deferred to its open parent closes even with an unreadable command: it runs nothing', async () => {
    const dir = repoDeclaring('echo from-the-file \u202E');
    const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })], { verifyAt: 'parent' }), { projectRoot: dir });
    const parent = await card(pid, 'WORK');
    const id = await card(pid, 'WORK', { parentId: parent });
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deferred to the parent/i);
  });

  it('judges the exact command selected to run, not the file as it reads by then', () => {
    // The close selects the file's command, awaits, then checks: a file edited meanwhile
    // to a readable command must not let the selected, unreadable one through.
    const dir = repoDeclaring('echo readable-now');
    const project = { projectRoot: dir };
    expect(unreadableFileVerify(project)).toBeNull();
    expect(unreadableFileVerify(project, 'echo hidden\u200B')).toMatchObject({ error: 'COMMAND_UNREADABLE', command: 'echo hidden\u200B' });
  });

  describe('review of #260', () => {
    const captureFlow = () => flow([s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('CHECK', 2), s('END', 3, { isAnchor: true })]);
    const report = { format: 'junit-xml', reportPath: 'report.xml' };
    const countOf = (text: string, needle: RegExp) => (text.match(new RegExp(needle.source, 'g')) ?? []).length;

    it('records a change seen only by intermediate captures', async () => {
      const first = markThenReport('FIRST_RAN');
      const dir = repoDeclaring(first);
      const pid = await project(await captureFlow(), { projectRoot: dir, testReport: report });
      const a = await card(pid, 'WORK');
      const bystander = await card(pid, 'WORK');
      expect((await validateFollowing(a)).body.error).toBeUndefined();

      const second = markThenReport('SECOND_RAN');
      writeDeclared(dir, second);
      const b = await card(pid, 'WORK');
      expect((await validateFollowing(b)).body.error).toBeUndefined();

      expect(await commentsOf(bystander)).toMatch(/Repository verify command changed/);
      const changes = ((await storage.getProject(pid)) as any).verifyCommandChanges ?? [];
      expect(changes.filter((c: any) => c.source === 'file')).toEqual([expect.objectContaining({ from: first, to: second })]);
    });

    it('keeps the note on a card whose close is deferred to its open parent', async () => {
      const dir = repoDeclaring(mark('FIRST_RAN'));
      const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })], { verifyAt: 'parent' }), { projectRoot: dir });
      const parent = await card(pid, 'WORK');
      const seed = await card(pid, 'WORK', { parentId: parent });
      const seeded = await validate(seed);
      expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);

      writeDeclared(dir, mark('SECOND_RAN'));
      const child = await card(pid, 'WORK', { parentId: parent });
      const res = await validate(child);
      expect(res.body.message, JSON.stringify(res.body)).toMatch(/deferred to the parent/i);
      expect(await commentsOf(child)).toMatch(/Repository verify command changed/);
    });

    it('announces a change once, and keeps one history entry, when verifies race', async () => {
      const first = mark('FIRST_RAN');
      const dir = repoDeclaring(first);
      const pid = await project(await twoSteps(), { projectRoot: dir });
      expect((await validate(await card(pid, 'WORK'))).body.error).toBeUndefined();

      const second = mark('SECOND_RAN');
      writeDeclared(dir, second);
      const bystander = await card(pid, 'WORK');
      // Three observations at once: each must see what the one before it wrote, so the change is
      // recorded - and announced - by exactly one of them. Counted at the write, because the cards'
      // own read-modify-write can swallow a duplicate note and hide the race.
      const writes = vi.spyOn(storage, 'updateProject');
      try {
        await Promise.all([observeDeclaredVerifyCommand(pid), observeDeclaredVerifyCommand(pid), observeDeclaredVerifyCommand(pid)]);
        expect(writes.mock.calls.filter(([id, u]) => id === pid && 'verifyCommandChanges' in (u as object))).toHaveLength(1);
      } finally { writes.mockRestore(); }

      expect(countOf(await commentsOf(bystander), /Repository verify command changed/)).toBe(1);
      const changes = ((await storage.getProject(pid)) as any).verifyCommandChanges ?? [];
      expect(changes.filter((c: any) => c.source === 'file')).toHaveLength(1);
    });

    it('records the exact command a capture or close selected, not the file as it reads by then', async () => {
      const first = mark('FIRST_RAN');
      const dir = repoDeclaring(first);
      const pid = await project(await twoSteps(), { projectRoot: dir });
      await observeDeclaredVerifyCommand(pid);
      const bystander = await card(pid, 'WORK');
      const selected = mark('SELECTED_RAN');
      // The file still declares `first`; the caller passes what it is about to run.
      await observeDeclaredVerifyCommand(pid, selected);
      const changes = ((await storage.getProject(pid)) as any).verifyCommandChanges ?? [];
      expect(changes.filter((c: any) => c.source === 'file')).toEqual([expect.objectContaining({ from: first, to: selected })]);
      expect(await commentsOf(bystander)).toContain(selected);
    });

    it('refuses an unreadable command on the background capture path, naming it, before anything runs', async () => {
      const command = `${markThenReport('FILE_RAN')} \u200B`;
      const dir = repoDeclaring(command);
      const pid = await project(await captureFlow(), { projectRoot: dir, testReport: report });
      const id = await card(pid, 'WORK');
      const res = await validateFollowing(id);
      expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_UNREADABLE');
      expect(res.body.command).toBe(command);
      expect(fs.existsSync(path.join(dir, 'FILE_RAN'))).toBe(false);
      expect((await storage.getItem(id))?.status).toBe('WORK');
    });

    it("refuses an unreadable command at the close before a stored report's suite spends a run", async () => {
      const dir = repoDeclaring('echo from-the-file \u202E');
      const pid = await project(await flow([s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('END', 2, { isAnchor: true })]), {
        projectRoot: dir, testReport: { ...report, command: markThenReport('REPORT_RAN') },
      });
      const id = await card(pid, 'WORK');
      const res = await validate(id);
      expect(res.body.error, JSON.stringify(res.body)).toBe('COMMAND_UNREADABLE');
      expect(fs.existsSync(path.join(dir, 'REPORT_RAN'))).toBe(false);
    });

    it('predicts that a capture of an unreadable command runs nothing', async () => {
      const dir = repoDeclaring('echo capture-marker \u200B');
      const pid = await project(await captureFlow(), { projectRoot: dir, testReport: report });
      const id = await card(pid, 'WORK');
      const plan = await agent().get(`/items/${id}/leave-plan`);
      expect(plan.body.refuses, JSON.stringify(plan.body)).toBe('COMMAND_UNREADABLE');
      expect(plan.body.advice).not.toContain('capture-marker');
      const predicted = await agent().get(`/items/${id}/leave-plan?predict=1`);
      expect(predicted.body.prediction.mode).toBe('none');
    });
  });
});
