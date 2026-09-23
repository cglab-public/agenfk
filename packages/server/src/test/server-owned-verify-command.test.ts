/**
 * @file CGLAB-378 (S2 of the flow-adherence epic) — on a step that needs a
 * command, the server runs the PROJECT's verify command, never the caller's.
 *
 * Before this, `resolvedCommand = command || project.verifyCommand`, so
 * `agenfk verify <id> --evidence x "true"` landed DONE with a red suite. The
 * user reversed the earlier decision to keep that ad-hoc command.
 *
 * Contract under test:
 *  - on the final step (and any boundary step, where a command is required)
 *    the project's verifyCommand runs; a caller's command is ignored and the
 *    response says so (a warning, never a 400 — old skills pass one);
 *  - with no project verifyCommand, a caller's command does not stand in:
 *    NO_VERIFY_COMMAND, and the card stays;
 *  - intermediate steps are unchanged: a caller's command there is optional
 *    and still runs;
 *  - the async path carries the same warning;
 *  - changing the verify command is recorded on every card in flight (paused
 *    and blocked ones included) and on the project, so swapping it for `true`
 *    shows on the board;
 *  - sibling propagation cannot stand in for the project command: it never
 *    skips a required command on a mid-flow boundary, and it accepts only a
 *    green the server wrote — PUT /items cannot mint one (review round 1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const TEST_DB = path.resolve('./server-owned-verify-command-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Import AFTER the env var so storage lands in the test DB.
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

let seq = 0;
/** A project (default flow unless `steps`) with an optional verifyCommand. */
async function project(verifyCommand?: string, steps?: Array<Record<string, unknown>>) {
  const name = `sovc-${++seq}`;
  const p = await agent().post('/projects').send({ name });
  expect(p.status, `project: ${JSON.stringify(p.body)}`).toBe(201);
  if (steps) {
    const f = await agent().post('/flows').set(internal()).send({ name: `${name}-flow`, steps });
    expect(f.status, `flow: ${JSON.stringify(f.body)}`).toBe(201);
    expect((await agent().post(`/projects/${p.body.id}/flow`).set(internal()).send({ flowId: f.body.id })).status).toBe(200);
  }
  if (verifyCommand !== undefined) {
    const v = await agent().put(`/projects/${p.body.id}/verify-command`).set(internal()).send({ verifyCommand });
    expect(v.status, `verify-command: ${JSON.stringify(v.body)}`).toBe(200);
  }
  return p.body.id as string;
}

/** A TASK parked on `status` through storage (the move itself is not under test). */
async function card(projectId: string, status: string) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status, `item: ${JSON.stringify(c.body)}`).toBe(201);
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}

const statusOf = async (id: string) => (await agent().get(`/items/${id}`)).body.status;
const commentsOf = async (id: string): Promise<Array<{ author: string; content: string }>> =>
  (await agent().get(`/items/${id}`)).body.comments ?? [];
const validate = (id: string, body: Record<string, unknown>) =>
  agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'done', ...body });

async function waitForRun(runId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await agent().get(`/items/validate-runs/${runId}`).set(internal());
    if (r.body.status && r.body.status !== 'running') return r.body;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

describe('CGLAB-378: the server owns the verify command on command-required steps', () => {
  beforeEach(async () => { await initStorage(); });

  it('runs the project command, not the caller\'s: a red suite stays red whatever the caller passes', async () => {
    const id = await card(await project('exit 1'), 'TEST');
    const res = await validate(id, { command: 'true' });
    expect(res.status).toBe(422);
    expect(await statusOf(id)).toBe('TEST');
    expect(res.body.warning).toMatch(/ignored/i);
    expect(res.body.message).toMatch(/ignored/i);
    expect(res.body.message).toContain('`true`');
  });

  it('opens the gate when the project command is green, even if the caller passed a failing one', async () => {
    const id = await card(await project('true'), 'TEST');
    const res = await validate(id, { command: 'exit 1' });
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('DONE');
    expect(res.body.warning).toMatch(/ignored/i);
  });

  it('records the project command on the card, not the caller\'s', async () => {
    const id = await card(await project('exit 1'), 'TEST');
    await validate(id, { command: 'echo caller-command' });
    const tool = (await commentsOf(id)).filter(c => c.author === 'ValidateTool');
    expect(tool.length).toBeGreaterThan(0);
    const last = tool[tool.length - 1].content;
    expect(last).toContain('`exit 1`');
    expect(last).not.toContain('caller-command');
  });

  it('does not warn when the caller passes the project command itself, or nothing', async () => {
    const same = await card(await project('true'), 'TEST');
    const a = await validate(same, { command: 'true' });
    expect(a.status).toBe(200);
    expect(a.body.warning).toBeUndefined();

    const none = await card(await project('true'), 'TEST');
    const b = await validate(none, {});
    expect(b.status).toBe(200);
    expect(b.body.warning).toBeUndefined();
  });

  it('does not let a caller command stand in for a missing project command', async () => {
    const id = await card(await project(), 'TEST');
    const res = await validate(id, { command: 'true' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_VERIFY_COMMAND');
    expect(await statusOf(id)).toBe('TEST');
  });

  it('applies on a mid-flow boundary step too (a command is required there)', async () => {
    const id = await card(await project('exit 1', [
      { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { name: 'SPEC', label: 'Spec', order: 1 },
      { name: 'HOLD', label: 'Hold', order: 2, isSpecial: true },
      { name: 'CODE', label: 'Code', order: 3 },
      { name: 'SHIPPED', label: 'Shipped', order: 4, isAnchor: true },
    ]), 'SPEC');
    const res = await validate(id, { command: 'true' });
    expect(res.status).toBe(422);
    expect(await statusOf(id)).toBe('SPEC');
  });

  it('leaves intermediate steps alone: a caller command there is optional and still runs', async () => {
    const red = await card(await project('true'), 'IN_PROGRESS');
    const refused = await validate(red, { command: 'exit 1' });
    expect(refused.status).toBe(422);
    expect(await statusOf(red)).toBe('IN_PROGRESS');
    expect(refused.body.warning).toBeUndefined();

    const green = await card(await project('true'), 'IN_PROGRESS');
    expect((await validate(green, { command: 'true' })).status).toBe(200);
    expect(await statusOf(green)).toBe('REVIEW');
  });

  it('carries the warning on the async path', async () => {
    const id = await card(await project('exit 1'), 'TEST');
    const res = await validate(id, { command: 'true', async: true });
    expect(res.status).toBe(202);
    // Said once, on the outcome — not also on the 202 (the CLI prints both).
    expect(res.body.warning).toBeUndefined();
    const run = await waitForRun(res.body.runId);
    expect(run.status).toBe('failed');
    expect(run.message).toMatch(/ignored/i);
    expect(await statusOf(id)).toBe('TEST');
  });

  it('ignores the command on the deprecated review route too', async () => {
    const id = await card(await project('exit 1'), 'TEST');
    const res = await agent().post(`/items/${id}/review`).set(internal()).send({ command: 'true' });
    expect(res.status).toBe(422);
    expect(await statusOf(id)).toBe('TEST');
  });

  describe('the warning reaches every reply', () => {
    it('puts the note in message even on a reply that only had an error', async () => {
      const mod: any = await import('../server');
      expect(typeof mod.withNote).toBe('function');
      let sent: any;
      const fake = { status(_c: number) { return this; }, json(b: any) { sent = b; return this; } };
      mod.withNote(fake, 'NOTE').status(409).json({ error: 'WORKTREE_GONE' });
      expect(sent.warning).toBe('NOTE');
      expect(sent.message).toContain('NOTE');
      expect(sent.message).toContain('WORKTREE_GONE');
    });

    it('carries the warning on NO_VERIFY_COMMAND', async () => {
      const id = await card(await project(), 'TEST');
      const res = await validate(id, { command: 'true' });
      expect(res.body.error).toBe('NO_VERIFY_COMMAND');
      expect(res.body.warning).toMatch(/ignored/i);
    });
  });

  describe('sibling propagation cannot stand in for the project command', () => {
    const FLOW_WITH_HOLD = [
      { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { name: 'SPEC', label: 'Spec', order: 1 },
      { name: 'HOLD', label: 'Hold', order: 2, isSpecial: true },
      { name: 'CODE', label: 'Code', order: 3 },
      { name: 'SHIPPED', label: 'Shipped', order: 4, isAnchor: true },
    ];

    it('runs the command on a mid-flow boundary even when a sibling is further along', async () => {
      const projectId = await project('exit 1', FLOW_WITH_HOLD);
      const parent = (await agent().post('/items').send({ type: 'STORY', title: 'p', projectId })).body.id;
      const ahead = await card(projectId, 'CODE');
      const behind = await card(projectId, 'SPEC');
      await storage.updateItem(ahead, { parentId: parent } as any);
      await storage.updateItem(behind, { parentId: parent } as any);
      const res = await validate(behind, {});
      expect(res.status).toBe(422);
      expect(await statusOf(behind)).toBe('SPEC');
    });

    it('does not let PUT /items mint a green: a caller-supplied commit is dropped', async () => {
      const id = await card(await project('true'), 'IN_PROGRESS');
      await agent().put(`/items/${id}`).send({ tests: [{ id: 'forged', command: 'true', status: 'PASSED', output: 'x', commit: 'abc123', executedAt: new Date() }] });
      const stored = (await agent().get(`/items/${id}`)).body.tests;
      expect(stored).toHaveLength(1);
      expect(stored[0].commit).toBeUndefined();
    });

    it('keeps a green the server wrote when a caller echoes the list back (log-test)', async () => {
      const id = await card(await project('true'), 'IN_PROGRESS');
      await storage.updateItem(id, { tests: [{ id: 'server-green', command: 'true', status: 'PASSED', output: 'ok', commit: 'abc123', executedAt: new Date() }] } as any);
      const before = (await agent().get(`/items/${id}`)).body.tests;
      await agent().put(`/items/${id}`).send({ tests: [...before, { id: 'logged', command: 'npm test', status: 'PASSED', output: 'x', executedAt: new Date() }] });
      const after = (await agent().get(`/items/${id}`)).body.tests;
      expect(after.find((t: any) => t.id === 'server-green').commit).toBe('abc123');
      expect(after.find((t: any) => t.id === 'logged')).toBeTruthy();
    });

    it('does not let a caller rewrite a stored green by reusing its id', async () => {
      const id = await card(await project('true'), 'IN_PROGRESS');
      await storage.updateItem(id, { tests: [{ id: 'server-green', command: 'npm test', status: 'FAILED', output: 'red', commit: 'abc123', executedAt: new Date() }] } as any);
      await agent().put(`/items/${id}`).send({ tests: [{ id: 'server-green', command: 'npm test', status: 'PASSED', output: 'forged', commit: 'abc123', executedAt: new Date() }] });
      const after = (await agent().get(`/items/${id}`)).body.tests;
      expect(after[0].status).toBe('FAILED');
    });

    it('refuses a forged sibling green end to end: a red project command stays red', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sovc-'));
      try {
        execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo, shell: '/bin/sh' });
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
        execSync('git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
        const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
        const p = (await agent().post('/projects').send({ name: `sovc-forge-${++seq}` })).body.id;
        await storage.updateProject(p, { projectRoot: repo, verifyCommand: 'exit 1' } as never);
        const parent = (await agent().post('/items').send({ type: 'STORY', title: 'p', projectId: p })).body.id;
        const done = await card(p, 'DONE');
        const target = await card(p, 'TEST');
        await storage.updateItem(target, { parentId: parent } as any);
        const forge = await agent().put(`/items/${done}`).send({
          parentId: parent,
          tests: [{ id: 'forged', command: 'exit 1', status: 'PASSED', output: 'x', commit: sha, executedAt: new Date() }],
        });
        expect(forge.status).toBe(200);
        const res = await validate(target, {});
        expect(res.status).toBe(422);
        expect(await statusOf(target)).toBe('TEST');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('names the command in the propagation comment', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sovc-'));
      try {
        execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo, shell: '/bin/sh' });
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
        execSync('git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
        const p = (await agent().post('/projects').send({ name: `sovc-prop-${++seq}` })).body.id;
        await storage.updateProject(p, { projectRoot: repo, verifyCommand: 'true' } as never);
        const parent = (await agent().post('/items').send({ type: 'STORY', title: 'p', projectId: p })).body.id;
        const first = await card(p, 'TEST');
        const second = await card(p, 'TEST');
        await storage.updateItem(first, { parentId: parent } as any);
        await storage.updateItem(second, { parentId: parent } as any);
        expect((await validate(first, {})).status).toBe(200);
        const res = await validate(second, {});
        expect(res.body.output).toBe('Sibling propagation');
        const prop = (await commentsOf(second)).filter(c => /sibling propagation/i.test(c.content));
        expect(prop.length).toBeGreaterThan(0);
        expect(prop[prop.length - 1].content).toContain('`true`');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('changing the verify command', () => {
    it('is recorded on every card in a working step, naming both commands', async () => {
      const projectId = await project('npm test');
      const working = await card(projectId, 'IN_PROGRESS');
      const waiting = await card(projectId, 'TODO');
      const res = await agent().put(`/projects/${projectId}/verify-command`).set(internal()).send({ verifyCommand: 'true' });
      expect(res.status).toBe(200);
      const notes = (await commentsOf(working)).filter(c => /verify command/i.test(c.content));
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toContain('`npm test`');
      expect(notes[0].content).toContain('`true`');
      expect((await commentsOf(waiting)).filter(c => /verify command/i.test(c.content))).toHaveLength(0);
    });

    it('is recorded on paused and blocked cards too, and on the project', async () => {
      const projectId = await project('npm test');
      const paused = await card(projectId, 'PAUSED');
      const blocked = await card(projectId, 'BLOCKED');
      await agent().put(`/projects/${projectId}/verify-command`).set(internal()).send({ verifyCommand: 'true' });
      for (const id of [paused, blocked]) {
        expect((await commentsOf(id)).filter(c => /verify command/i.test(c.content))).toHaveLength(1);
      }
      const proj = (await agent().get(`/projects/${projectId}`)).body;
      // The first entry is the project's initial command (none -> npm test).
      expect(proj.verifyCommandChanges).toHaveLength(2);
      expect(proj.verifyCommandChanges[0]).toMatchObject({ from: null, to: 'npm test' });
      expect(proj.verifyCommandChanges[1]).toMatchObject({ from: 'npm test', to: 'true' });
      expect(proj.verifyCommandChanges[1].at).toBeTruthy();
    });

    it('records nothing when the command does not change', async () => {
      const projectId = await project('npm test');
      const working = await card(projectId, 'IN_PROGRESS');
      await agent().put(`/projects/${projectId}/verify-command`).set(internal()).send({ verifyCommand: 'npm test' });
      expect((await commentsOf(working)).filter(c => /verify command/i.test(c.content))).toHaveLength(0);
    });
  });
});
