/**
 * @file cf6941e0 (CGLAB-430) — the verifies running now, across every project.
 *
 * User 2026-09-28: "Ongoing verify calls >10s should appear somewhere in the
 * UI so the user can click on it and open the respective card (independent of
 * project)." The server knew each run only by its card. GET /verify-runs now
 * lists them all - card, project, step, when it started, what it is doing
 * (waiting for a suite-run slot, running the whole suite or only the affected
 * tests, waiting on a person) and the last line it printed - and the
 * 'verify_runs' socket event pushes the same list when it changes. It carries
 * no step records and no output bodies: it is the read that must stay cheap
 * (cb4ef070).
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('verify-runs-list-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN, io } from '../server';
import { posixShell } from './helpers/posixShell';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => {
  await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
  await new Promise<void>(r => __server.close(() => r()));
});
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: posixShell(), encoding: 'utf8' }).trim();
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });
const until = async (pred: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await new Promise(r => setTimeout(r, 30)); }
  const now = (await agent().get('/verify-runs')).body;
  expect(false, `timed out waiting for the condition; /verify-runs now: ${JSON.stringify(now)}`).toBe(true);
};
const list = async () => {
  const r = await agent().get('/verify-runs');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as any[];
};
const entryFor = async (itemId: string) => (await list()).find(e => e.itemId === itemId);
const verifyAsync = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', async: true });

/**
 * A verify command that prints `lines`, then runs until the test releases it
 * (30s at most, so a failing spec cannot hang). Where a spec needs two runs to
 * overlap, a fixed sleep is a race: on a slow box (#208: antivirus watching
 * every process start) the first run ended before the second began.
 */
function heldScript(lines: string[] = ['running']) {
  const dir = tmp('agenfk-vr-hold-');
  const gate = path.join(dir, 'release');
  const script = path.join(dir, 'run.js');
  fs.writeFileSync(script, `for (const l of ${JSON.stringify(lines)}) console.log(l);\n`
    + `const fs = require('fs'); const end = Date.now() + 30000;\n`
    + `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)}) || Date.now() > end) clearInterval(t); }, 50);\n`);
  const release = () => fs.writeFileSync(gate, '');
  held.push(release);
  return { script, release };
}
// A spec that fails before releasing its runs must not leave them holding the
// suite slot for 30s: the next spec would time out on them instead of its own cause.
const held: Array<() => void> = [];
afterEach(() => { for (const release of held.splice(0)) release(); });

/** A card on WORK whose leaving runs its suite (suite-green): a command that prints `lines`, then takes `ms`, or runs until `release()` when `held`. */
async function card(opts: { ms?: number; lines?: string[]; name?: string; held?: boolean } = {}) {
  const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('NEXT', 2), s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-vr-repo-');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
  let script: string;
  let release = () => {};
  if (opts.held) ({ script, release } = heldScript(opts.lines));
  else fs.writeFileSync(script = path.join(tmp('agenfk-vr-tools-'), 'run.js'),`for (const l of ${JSON.stringify(opts.lines ?? ['running'])}) console.log(l);\nsetTimeout(() => {}, ${opts.ms ?? 1500});\n`);
  const p = await agent().post('/projects').send({ name: opts.name ?? `vr-project-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: `node ${script}` } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return { id: c.body.id as string, pid: p.body.id as string, title: c.body.title as string, projectName: p.body.name as string, release };
}

describe('GET /verify-runs: every verify running now, in any project', () => {
  it('lists running verifies from two projects with their card, project, step and start, and forgets them when they end', async () => {
    const a = await card({ name: 'alpha-project', held: true });
    const b = await card({ name: 'beta-project', held: true });
    expect((await verifyAsync(a.id)).status).toBe(202);
    expect((await verifyAsync(b.id)).status).toBe(202);
    await until(async () => (await list()).filter(e => [a.id, b.id].includes(e.itemId)).length === 2);
    const ea = await entryFor(a.id);
    expect(ea).toMatchObject({ itemId: a.id, title: a.title, projectId: a.pid, projectName: 'alpha-project', step: 'WORK' });
    expect(typeof ea.runId).toBe('string');
    expect(Number.isNaN(Date.parse(ea.startedAt))).toBe(false);
    expect(await entryFor(b.id)).toMatchObject({ projectName: 'beta-project' });
    a.release(); b.release();
    await until(async () => !(await entryFor(a.id)) && !(await entryFor(b.id)));
  });

  it('lists what a running verify is doing and the last line it printed (colour codes stripped), and carries no step records or output body', async () => {
    const c = await card({ lines: ['first', 'second', '\u001b[32m✓ third line\u001b[0m', ''] });
    expect((await verifyAsync(c.id)).status).toBe(202);
    await until(async () => { const e = await entryFor(c.id); return e?.lastLine === '✓ third line' && e?.phase?.state === 'running'; });
    const e = await entryFor(c.id);
    // A verify running its suite says it is running the whole suite.
    expect(e.phase).toMatchObject({ state: 'running', kind: 'whole' });
    for (const heavy of ['output', 'tail', 'stepRecords', 'tests', 'checks', 'message']) expect(e, heavy).not.toHaveProperty(heavy);
    await until(async () => !(await entryFor(c.id)));
  });

  it('a verify waiting for a suite-run slot says so, and how many runs are ahead of it', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1 });
    try {
      const a = await card({ held: true });
      const b = await card({ ms: 200 });
      expect((await verifyAsync(a.id)).status).toBe(202);
      await until(async () => (await entryFor(a.id))?.phase?.state === 'running');
      expect((await verifyAsync(b.id)).status).toBe(202);
      await until(async () => (await entryFor(b.id))?.phase?.state === 'queued');
      expect((await entryFor(b.id)).phase).toMatchObject({ state: 'queued', ahead: 1 });
      a.release();
      await until(async () => !(await entryFor(a.id)) && !(await entryFor(b.id)), 15_000);
    } finally {
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
    }
  });
});

describe('affected-only runs say what they run', () => {
  it('names an affected-only run and how many changed files it covers', async () => {
    const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('PLAN', 1, { checks: [{ id: 'suite-green' }] }), s('BUILD', 2, { checks: [{ id: 'suite-green' }] }), s('SHIP', 3), s('END', 4, { isAnchor: true }),
    ] });
    const repo = tmp('agenfk-vr-aff-');
    fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass adds\n');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
    const runner = path.join(tmp('agenfk-vr-afftools-'), 'runner.js');
    // Reports a.test.js; a related run takes a while so it can be seen.
    fs.writeFileSync(runner, `const fs = require('fs');
fs.writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="adds" file="a.test.js"/></testsuite></testsuites>');
setTimeout(() => {}, process.argv[2] === 'related' ? 1500 : 0);`);
    const p = await agent().post('/projects').send({ name: `vr-aff-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'exit 0',
      testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml', relatedCommand: `node ${runner} related {files}` } } as never);
    const c = (await agent().post('/items').send({ type: 'TASK', title: `aff-${++seq}`, projectId: p.body.id })).body;
    await storage.updateItem(c.id, { status: 'PLAN' } as any);
    expect((await agent().post(`/items/${c.id}/validate`).set(internal()).send({ evidence: 'ok' })).status).toBe(200);
    fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 2;\n');
    expect((await verifyAsync(c.id)).status).toBe(202);
    await until(async () => (await entryFor(c.id))?.phase?.kind === 'affected');
    expect((await entryFor(c.id)).phase).toMatchObject({ state: 'running', kind: 'affected', files: 1 });
    await until(async () => !(await entryFor(c.id)));
  });
});

describe("the 'verify_runs' socket event", () => {
  it('pushes the list when a verify starts and again when it ends', async () => {
    const emit = vi.spyOn(io, 'emit');
    try {
      const c = await card({ ms: 300 });
      expect((await verifyAsync(c.id)).status).toBe(202);
      const pushes = () => emit.mock.calls.filter(([ev]) => ev === 'verify_runs').map(([, body]) => body as any[]);
      await until(async () => pushes().some(l => l.some(e => e.itemId === c.id)));
      await until(async () => { const all = pushes(); return all.length > 0 && !all[all.length - 1].some(e => e.itemId === c.id); });
    } finally {
      emit.mockRestore();
    }
  });
});

// 08f40965 (found in the browser check): a final-step verify's output was never pushed - only its start and end.
describe("the 'verify_runs' push follows a final-step verify's output", () => {
  it('pushes the last line as the command prints it', async () => {
    const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
    const repo = tmp('agenfk-vr-final-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
    const script = path.join(tmp('agenfk-vr-finaltools-'), 'run.js');
    fs.writeFileSync(script, "console.log('first');\nsetTimeout(() => console.log('second'), 700);\nsetTimeout(() => {}, 1600);\n");
    const p = await agent().post('/projects').send({ name: `vr-final-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: `node ${script}` } as never);
    const c = (await agent().post('/items').send({ type: 'TASK', title: `final-${++seq}`, projectId: p.body.id })).body;
    await storage.updateItem(c.id, { status: 'WORK' } as any);
    const emit = vi.spyOn(io, 'emit');
    try {
      expect((await verifyAsync(c.id)).status).toBe(202);
      const pushed = () => emit.mock.calls.filter(([ev]) => ev === 'verify_runs').flatMap(([, body]) => body as any[]).filter(e => e.itemId === c.id);
      await until(async () => pushed().some(e => e.lastLine === 'second'));
    } finally {
      emit.mockRestore();
    }
    await until(async () => !(await entryFor(c.id)));
  });
});

// beae41a0 (review of CGLAB-430): what makes an entry go, what it says while it waits, and how often it is pushed.
describe('beae41a0: the list stays true', () => {
  const board = () => ({ 'x-agenfk-ui': '1' });
  /** A card held on WORK by a person's approval: listed as waiting on a person. */
  async function held() {
    const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'human-approval' }] }), s('NEXT', 2), s('END', 3, { isAnchor: true }),
    ] });
    const repo = tmp('agenfk-vr-held-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
    const p = await agent().post('/projects').send({ name: `vr-held-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'exit 0' } as never);
    const c = (await agent().post('/items').send({ type: 'TASK', title: `held-${++seq}`, projectId: p.body.id })).body;
    await storage.updateItem(c.id, { status: 'WORK' } as any);
    expect((await agent().post(`/items/${c.id}/validate`).set(internal()).send({ evidence: 'ok' })).status).toBe(422);
    // A verify held only by a person is listed as waiting on one.
    expect(await entryFor(c.id)).toMatchObject({ itemId: c.id, step: 'WORK', phase: { state: 'awaiting-person' } });
    return c.id as string;
  }

  it('a person-wait goes when the person approves', async () => {
    const id = await held();
    expect((await agent().post(`/items/${id}/approvals`).set(board()).send({ step: 'WORK' })).status).toBeLessThan(300);
    expect(await entryFor(id)).toBeUndefined();
  });

  it('a person-wait goes when the card is moved', async () => {
    const id = await held();
    expect((await agent().put(`/items/${id}`).set(internal()).send({ status: 'START' })).status).toBe(200);
    expect(await entryFor(id)).toBeUndefined();
  });

  it('a person-wait goes when the card is deleted', async () => {
    const id = await held();
    expect((await agent().delete(`/items/${id}`).set(internal())).status).toBeLessThan(300);
    expect(await entryFor(id)).toBeUndefined();
  });

  it('output printed line by line is pushed a few times, not once per line', async () => {
    // 2ec08b41: one line every 20 ms, so each reaches the server as its own chunk - lines printed at once arrive in a
    // handful of chunks, and the test passed with the coalescing removed.
    const c = await card({ ms: 0 });
    const script = path.join(tmp('agenfk-vr-drip-'), 'drip.js');
    fs.writeFileSync(script, "let i = 0; const t = setInterval(() => { console.log('line ' + i); if (++i >= 60) clearInterval(t); }, 20);\n");
    const proj: any = (await storage.getItem(c.id) as any);
    await storage.updateProject(proj.projectId, { verifyCommand: `node ${script}` } as never);
    const emit = vi.spyOn(io, 'emit');
    try {
      expect((await verifyAsync(c.id)).status).toBe(202);
      await until(async () => !(await entryFor(c.id)));
      const mine = emit.mock.calls.filter(([ev, body]) => ev === 'verify_runs' && (body as any[]).some(e => e.itemId === c.id));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.length).toBeLessThanOrEqual(10);
    } finally {
      emit.mockRestore();
    }
  });

  it('a verify waiting on an identical capture of the same tree says so', async () => {
    const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('NEXT', 2), s('END', 3, { isAnchor: true }),
    ] });
    const repo = tmp('agenfk-vr-sf-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
    const { script, release } = heldScript();
    const p = await agent().post('/projects').send({ name: `vr-sf-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: `node ${script}` } as never);
    const mk = async () => { const c = (await agent().post('/items').send({ type: 'TASK', title: `sf-${++seq}`, projectId: p.body.id })).body; await storage.updateItem(c.id, { status: 'WORK' } as any); return c.id as string; };
    const a = await mk(); const b = await mk();
    expect((await verifyAsync(a)).status).toBe(202);
    await until(async () => (await entryFor(a))?.phase?.state === 'running');
    expect((await verifyAsync(b)).status).toBe(202);
    await until(async () => (await entryFor(b))?.phase?.state === 'waiting');
    expect((await entryFor(b)).phase).toEqual({ state: 'waiting', on: 'identical-run' });
    release();
    await until(async () => !(await entryFor(a)) && !(await entryFor(b)));
  });

  it("a sibling's final verify waiting on the other's run says so, and shows its output", async () => {
    const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
    const repo = tmp('agenfk-vr-sib-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
    const { script, release } = heldScript();
    const p = await agent().post('/projects').send({ name: `vr-sib-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: `node ${script}` } as never);
    const parent = (await agent().post('/items').send({ type: 'STORY', title: 'p', projectId: p.body.id })).body;
    const mk = async () => { const c = (await agent().post('/items').send({ type: 'TASK', title: `sib-${++seq}`, projectId: p.body.id, parentId: parent.id })).body; await storage.updateItem(c.id, { status: 'WORK' } as any); return c.id as string; };
    const a = await mk(); const b = await mk();
    expect((await verifyAsync(a)).status).toBe(202);
    await until(async () => (await entryFor(a))?.phase?.state === 'running');
    expect((await verifyAsync(b)).status).toBe(202);
    await until(async () => (await entryFor(b))?.phase?.state === 'waiting');
    expect((await entryFor(b)).phase).toEqual({ state: 'waiting', on: 'sibling' });
    expect((await entryFor(b)).lastLine).toMatch(/sibling is running the same command/);
    release();
    await until(async () => !(await entryFor(a)) && !(await entryFor(b)));
  });

  // 2ec08b41: the person-wait goes only when the card really moves, or the person really approves.
  it('a save that leaves the status as it was keeps the person-wait', async () => {
    const id = await held();
    expect((await agent().put(`/items/${id}`).set(board()).send({ status: 'WORK', title: 'typo fixed' })).status).toBe(200);
    expect((await entryFor(id))?.phase).toEqual({ state: 'awaiting-person' });
  });

  it('a move the server refuses keeps the person-wait', async () => {
    const id = await held();
    expect((await agent().put(`/items/${id}`).set(internal()).send({ status: 'END' })).status).toBeGreaterThanOrEqual(400);
    expect((await entryFor(id))?.phase).toEqual({ state: 'awaiting-person' });
  });

  it('an approval the server refuses keeps the person-wait', async () => {
    const f = await agent().post('/flows').send({ name: `vr-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'human-approval', params: { signature: 'passkey' } }] }), s('NEXT', 2), s('END', 3, { isAnchor: true }),
    ] });
    const repo = tmp('agenfk-vr-pk-');
    git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one');
    const p = await agent().post('/projects').send({ name: `vr-pk-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'exit 0' } as never);
    const c = (await agent().post('/items').send({ type: 'TASK', title: `pk-${++seq}`, projectId: p.body.id })).body;
    await storage.updateItem(c.id, { status: 'WORK' } as any);
    expect((await agent().post(`/items/${c.id}/validate`).set(internal()).send({ evidence: 'ok' })).status).toBe(422);
    expect((await entryFor(c.id))?.phase).toEqual({ state: 'awaiting-person' });
    // No passkey assertion: a passkey step refuses the board's word alone.
    expect((await agent().post(`/items/${c.id}/approvals`).set(board()).send({ step: 'WORK' })).status).toBeGreaterThanOrEqual(400);
    expect((await entryFor(c.id))?.phase).toEqual({ state: 'awaiting-person' });
  });
});

