/**
 * @file f8d0a752 — a server-wide limit on concurrent suite runs.
 *
 * Several agents verifying at once each ran a full suite at full parallelism;
 * on horizon-lab that put a 12-core machine at load 76-88 and timing tests
 * failed only under agenfk. Suite runs - step captures and the final-step
 * verify command - now take a slot; beyond the limit they wait in a FIFO
 * queue and say so. The limit is the server-wide app setting
 * maxConcurrentSuiteRuns: 0 is automatic (half the CPUs, at least 1),
 * anything else is used as given, up to the CPU count.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('suite-slots-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN, acquireSuiteRun } from '../server';
import { posixShell } from './helpers/posixShell';
// Loaded per test: the module is new, and a test file that fails to import has no tests to track.
const slotsModule = () => import('../suiteSlots');

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

describe('suiteRunLimit', () => {
  let suiteRunLimit: (cpus: number, setting: number) => number;
  // Swallowed: a failing beforeAll SKIPS the tests; each must fail on its own instead.
  beforeAll(async () => { try { ({ suiteRunLimit } = await slotsModule()); } catch { /* not there yet */ } });
  it('is half the CPUs, at least 1, when automatic', () => {
    expect(suiteRunLimit(12, 0)).toBe(6);
    expect(suiteRunLimit(3, 0)).toBe(1);
    expect(suiteRunLimit(1, 0)).toBe(1);
  });

  it('uses a configured value as given, up to the CPU count', () => {
    expect(suiteRunLimit(12, 4)).toBe(4);
    expect(suiteRunLimit(12, 9)).toBe(9);
    expect(suiteRunLimit(12, 40)).toBe(12);
  });

  it('treats anything that is not a positive whole number as automatic', () => {
    for (const v of [-2, 2.5, Number.NaN, undefined as unknown as number]) expect(suiteRunLimit(12, v), String(v)).toBe(6);
  });
});

describe('SuiteSlots', () => {
  let SuiteSlots: any;
  // Swallowed: a failing beforeAll SKIPS the tests; each must fail on its own instead.
  beforeAll(async () => { try { ({ SuiteSlots } = await slotsModule()); } catch { /* not there yet */ } });
  const tick = () => new Promise(r => setTimeout(r, 5));

  it('runs up to the limit at once and queues the rest, first in first out', async () => {
    const slots = new SuiteSlots(() => 2);
    const order: string[] = [];
    const gates: Record<string, () => void> = {};
    const job = (name: string) => slots.run(() => new Promise<void>(r => { order.push(`start ${name}`); gates[name] = () => { order.push(`end ${name}`); r(); }; }));
    const a = job('a'); const b = job('b'); const c = job('c'); const d = job('d');
    await tick();
    expect(order).toEqual(['start a', 'start b']);
    gates.b(); await tick();
    expect(order).toEqual(['start a', 'start b', 'end b', 'start c']);
    gates.a(); await tick();
    expect(order.slice(-2)).toEqual(['end a', 'start d']);
    gates.c(); gates.d();
    await Promise.all([a, b, c, d]);
  });

  it('tells a queued run how many are ahead of it and what the limit is', async () => {
    const slots = new SuiteSlots(() => 1);
    let release!: () => void;
    const first = slots.run(() => new Promise<void>(r => { release = r; }));
    const waits: Array<{ ahead: number; limit: number }> = [];
    const second = slots.run(async () => {}, w => waits.push(w));
    const third = slots.run(async () => {}, w => waits.push(w));
    await tick();
    expect(waits).toEqual([{ ahead: 1, limit: 1 }, { ahead: 2, limit: 1 }]);
    release();
    await Promise.all([first, second, third]);
  });

  it('frees the slot when a run throws', async () => {
    const slots = new SuiteSlots(() => 1);
    await expect(slots.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let ran = false;
    await slots.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  // beae41a0: a waiter was told its place once, as it joined the queue.
  it('tells a waiting run its new place as runs ahead of it finish', async () => {
    const { SuiteSlots } = await slotsModule();
    const slots = new SuiteSlots(() => 1);
    const releaseFirst = await slots.acquire();
    const seen: number[] = [];
    const second = slots.acquire();
    const third = slots.acquire(w => seen.push(w.ahead));
    expect(seen).toEqual([2]);
    releaseFirst();
    (await second)();
    (await third)();
    expect(seen).toEqual([2, 1]);
  });

  it('reads the limit when a slot frees, so a raised limit lets the queue through', async () => {
    let limit = 1;
    const slots = new SuiteSlots(() => limit);
    const started: string[] = [];
    let releaseA!: () => void;
    const a = slots.run(() => new Promise<void>(r => { started.push('a'); releaseA = r; }));
    const b = slots.run(async () => { started.push('b'); });
    const c = slots.run(async () => { started.push('c'); });
    await tick();
    expect(started).toEqual(['a']);
    limit = 3;
    releaseA();
    await Promise.all([a, b, c]);
    expect(started).toEqual(['a', 'b', 'c']);
  });
});

describe('the setting', () => {
  it('is stored server-wide through PUT /settings and read back', async () => {
    const r = await agent().put('/settings').send({ maxConcurrentSuiteRuns: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await agent().get('/settings')).body.maxConcurrentSuiteRuns).toBe(3);
  });

  it('refuses a value that is not 0 or a whole number of runs', async () => {
    expect((await agent().put('/settings').send({ maxConcurrentSuiteRuns: -1 })).status).toBe(400);
    expect((await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1.5 })).status).toBe(400);
  });
});

// Long enough for two runs to overlap when they may: on Windows the git work before
// each run starts takes longer than the 400ms POSIX needs (#208).
// #264: 400ms was shorter than a run's start-up on a loaded machine, so 'they overlap' tests failed there.
const RUN_MS = process.platform === 'win32' ? 3000 : 1000;
/** Two projects whose suite command logs its start and end (ms) to one file outside both trees. */
let seq = 0;
async function twoProjects(kind: 'capture' | 'final') {
  const log = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-slots-log-'))), 'log');
  dirs.push(path.dirname(log));
  const runner = path.join(path.dirname(log), 'runner.js');
  fs.writeFileSync(runner, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, 'start ' + Date.now() + '\\n');
setTimeout(() => {
  fs.writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="ok" file="t.test.js"/></testsuite></testsuites>');
  fs.appendFileSync(${JSON.stringify(log)}, 'end ' + Date.now() + '\\n');
  process.exit(0);
}, ${RUN_MS});`);
  const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });
  const cards: string[] = [];
  for (let i = 0; i < 2; i++) {
    const f = await agent().post('/flows').send({ name: `slots-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-slots-repo-')));
    dirs.push(repo);
    execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: posixShell() });
    const p = await agent().post('/projects').send({ name: `slots-${++seq}` });
    await storage.updateProject(p.body.id, {
      flowId: f.body.id, projectRoot: repo,
      verifyCommand: kind === 'final' ? `node ${runner}` : 'exit 0',
      ...(kind === 'capture' ? { testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } : {}),
    } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: `slots-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    cards.push(c.body.id);
  }
  const intervals = () => {
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => l.split(' '));
    return { starts: lines.filter(l => l[0] === 'start').map(l => Number(l[1])), ends: lines.filter(l => l[0] === 'end').map(l => Number(l[1])) };
  };
  return { cards, intervals };
}
const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

// Serialised runs here take several RUN_MS: past vitest's 5s default.
describe('suite runs across projects take a slot', { timeout: 60_000 }, () => {
  it('two captures in two projects do not overlap when the limit is 1', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1 });
    const t = await twoProjects('capture');
    const rs = await Promise.all(t.cards.map(id => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({})));
    for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { starts, ends } = t.intervals();
    expect(starts).toHaveLength(2);
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(Math.min(...ends));
  });

  it("two final-step verifies in two projects do not overlap when the limit is 1", async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1 });
    const t = await twoProjects('final');
    const rs = await Promise.all(t.cards.map(id => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' })));
    for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { starts, ends } = t.intervals();
    expect(starts).toHaveLength(2);
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(Math.min(...ends));
  });

  // 80920048 (review of 6caae168, finding 9): the queue was drained only when a slot freed.
  it('raising the limit while a run waits starts it at once, not when the running one ends', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 1 });
    const t = await twoProjects('capture');
    const pending = t.cards.map(id => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({}).then(r => r));
    const started = () => { try { return t.intervals().starts.length; } catch { return 0; } };
    for (let i = 0; i < 200 && started() < 1; i++) await new Promise(r => setTimeout(r, 10));
    expect(started()).toBe(1);
    expect((await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 })).status).toBe(200);
    for (const r of await Promise.all(pending)) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { starts, ends } = t.intervals();
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  });

  it('with room for both, they run at once', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 });
    const t = await twoProjects('capture');
    await Promise.all(t.cards.map(id => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({})));
    const { starts, ends } = t.intervals();
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  });
});

/*
 * 7ddeaf7c — exclusiveSuite: a project whose suites share something outside
 * the tree (one database, fixed ports) runs one at a time, whatever the
 * server-wide limit allows - and only that project waits for it.
 */
/** One project, two cards each in its own worktree of the repo (no reuse between them), plus a card in another project. */
async function exclusiveProject(kind: 'capture' | 'final', exclusive: boolean, ms: { A?: number; B?: number } = {}) {
  const log = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-excl-log-'))), 'log');
  dirs.push(path.dirname(log));
  const runner = path.join(path.dirname(log), 'runner.js');
  // Each run logs which project it belongs to, read from its argument.
  fs.writeFileSync(runner, `const fs = require('fs');
const who = process.argv[2];
fs.appendFileSync(${JSON.stringify(log)}, 'start ' + who + ' ' + Date.now() + '\\n');
setTimeout(() => {
  fs.writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="ok" file="t.test.js"/></testsuite></testsuites>');
  fs.appendFileSync(${JSON.stringify(log)}, 'end ' + who + ' ' + Date.now() + '\\n');
  process.exit(0);
}, who === 'B' ? ${ms.B ?? Math.round(RUN_MS / 2)} : ${ms.A ?? RUN_MS});`);
  const s = (name: string, order: number) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...(name !== 'WORK' ? { isAnchor: true } : {}) });
  const make = async (who: string, extra: Record<string, unknown>) => {
    const f = await agent().post('/flows').send({ name: `excl-${++seq}`, steps: [s('START', 0), s('WORK', 1), s('END', 2)] });
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-excl-repo-')));
    dirs.push(repo);
    execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: posixShell() });
    const p = await agent().post('/projects').send({ name: `excl-${++seq}` });
    const cmd = `node ${runner} ${who}`;
    await storage.updateProject(p.body.id, {
      flowId: f.body.id, projectRoot: repo, ...extra,
      verifyCommand: kind === 'final' ? cmd : 'exit 0',
      ...(kind === 'capture' ? { testReport: { format: 'junit-xml', command: cmd, reportPath: 'report.xml' } } : {}),
    } as never);
    return { pid: p.body.id as string, repo };
  };
  const cardIn = async (pid: string, worktreePath?: string) => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `excl-${++seq}`, projectId: pid });
    await storage.updateItem(c.body.id, { status: 'WORK', ...(worktreePath ? { worktreePath } : {}) } as any);
    return c.body.id as string;
  };
  const a = await make('A', exclusive ? { exclusiveSuite: true } : {});
  const wts = ['one', 'two'].map(n => {
    const wt = `${a.repo}-${n}`;
    dirs.push(wt);
    execSync(`git worktree add -q -b ${n} ${JSON.stringify(wt)}`, { cwd: a.repo });
    return wt;
  });
  const b = await make('B', {});
  const sameProject = [await cardIn(a.pid, wts[0]), await cardIn(a.pid, wts[1])];
  const otherProject = await cardIn(b.pid);
  const intervals = (who: string) => {
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')).filter(l => l[1] === who);
    return { starts: lines.filter(l => l[0] === 'start').map(l => Number(l[2])), ends: lines.filter(l => l[0] === 'end').map(l => Number(l[2])) };
  };
  return { sameProject, otherProject, intervals, pid: a.pid };
}
const runVerify = (kind: 'capture' | 'final', id: string) => kind === 'capture'
  ? agent().post(`/items/${id}/step-records/capture`).set(internal()).send({})
  : agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });

// Runs here are serialised on purpose (several RUN_MS each, 3s on Windows): well past vitest's 5s default.
describe('exclusiveSuite: one suite run at a time in the project', { timeout: 60_000 }, () => {
  for (const kind of ['capture', 'final'] as const) {
    it(`two ${kind === 'capture' ? 'captures' : 'final-step verifies'} in an exclusive project do not overlap, while another project's run is not held back`, async () => {
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 });
      try {
        // A's runs long enough that the git work before B's run, slow under a loaded full-suite run, cannot outlast A's first one.
        const t = await exclusiveProject(kind, true, { A: RUN_MS * 5 });
        const rs = await Promise.all([...t.sameProject, t.otherProject].map(id => runVerify(kind, id)));
        for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(200);
        const a = t.intervals('A');
        expect(a.starts).toHaveLength(2);
        expect(Math.max(...a.starts), 'the exclusive project ran two suites at once').toBeGreaterThanOrEqual(Math.min(...a.ends));
        // The other project's run overlapped the first of A's: it was not queued behind A's second.
        const b = t.intervals('B');
        expect(b.starts).toHaveLength(1);
        expect(b.starts[0], "another project's run waited for the exclusive project").toBeLessThan(Math.min(...a.ends));
      } finally {
        await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
      }
    });
  }

  it('without it, the same two runs overlap: the limit is the server-wide one', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 });
    try {
      const t = await exclusiveProject('capture', false);
      for (const r of await Promise.all(t.sameProject.map(id => runVerify('capture', id)))) expect(r.status, JSON.stringify(r.body)).toBe(200);
      const a = t.intervals('A');
      expect(Math.max(...a.starts)).toBeLessThan(Math.min(...a.ends));
    } finally {
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
    }
  });

  // Review of 7ddeaf7c (Codex #5): a run already going when the setting is turned on still counts.
  it('turning it on while a run is going makes the next run wait for that one', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 });
    try {
      const t = await exclusiveProject('capture', false);
      const first = runVerify('capture', t.sameProject[0]).then(r => r);
      const started = () => { try { return t.intervals('A').starts.length; } catch { return 0; } };
      for (let i = 0; i < 300 && started() < 1; i++) await new Promise(r => setTimeout(r, 10));
      expect(t.intervals('A').starts).toHaveLength(1);
      expect((await agent().put(`/projects/${t.pid}`).send({ exclusiveSuite: true })).status).toBe(200);
      const second = await runVerify('capture', t.sameProject[1]);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect((await first).status).toBe(200);
      const a = t.intervals('A');
      expect(Math.max(...a.starts), 'the second run overlapped one started before the setting was on').toBeGreaterThanOrEqual(Math.min(...a.ends));
    } finally {
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
    }
  });

  // Review of 7ddeaf7c, second pass: a run admitted to the project's line before the setting, still waiting for a server slot.
  it('a run already queued for a server slot when it is turned on does not start beside the project\'s running one', async () => {
    await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 });
    try {
      // A's runs outlast B's by far, so B's slot frees while A's first run is still going.
      const t = await exclusiveProject('capture', false, { A: RUN_MS * 5, B: Math.round(RUN_MS / 2) });
      const count = (who: string) => { try { return t.intervals(who).starts.length; } catch { return 0; } };
      const a1 = runVerify('capture', t.sameProject[0]).then(r => r);
      for (let i = 0; i < 300 && count('A') < 1; i++) await new Promise(r => setTimeout(r, 10));
      const b1 = runVerify('capture', t.otherProject).then(r => r);
      for (let i = 0; i < 300 && count('B') < 1; i++) await new Promise(r => setTimeout(r, 10));
      // Both server slots are taken: A's second run is admitted to its (unlimited) project line and waits for one.
      const a2 = runVerify('capture', t.sameProject[1]).then(r => r);
      await new Promise(r => setTimeout(r, 150));
      expect((await agent().put(`/projects/${t.pid}`).send({ exclusiveSuite: true })).status).toBe(200);
      // B ends first and frees a server slot while A's first run is still going.
      for (const r of await Promise.all([a1, b1, a2])) expect(r.status, JSON.stringify(r.body)).toBe(200);
      const a = t.intervals('A');
      expect(a.starts).toHaveLength(2);
      expect(Math.max(...a.starts), "A's queued run started beside its running one").toBeGreaterThanOrEqual(Math.min(...a.ends));
    } finally {
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
    }
  });

  /*
   * #264: a project read that starts before the setting is turned on and lands
   * after must not switch it back off - at the top of acquireSuiteRun, or at
   * its re-check after the server slot. Synchronised on the held read being
   * entered and on the second run queueing for the project, not on sleeps.
   */
  for (const [which, heldCall] of [['the first read', 1], ['the re-check read', 2]] as const) {
    it(`a stale project read (${which}) cannot let a run start beside the project's running one`, async () => {
      await agent().put('/settings').send({ maxConcurrentSuiteRuns: 2 });
      const releases: Array<() => void> = [];
      const spies: Array<{ mockRestore: () => void }> = [];
      try {
        // With one server slot, the slot alone would keep the runs apart and this would prove nothing.
        expect((await agent().get('/settings/runtime')).body.suiteRunLimit, 'needs two server slots').toBeGreaterThanOrEqual(2);
        const pid = (await agent().post('/projects').send({ name: `stale-${++seq}` })).body.id as string;
        releases.push(await acquireSuiteRun(pid, () => {}));
        const stale = await storage.getProject(pid);
        let letGo!: () => void;
        const held = new Promise<void>(r => { letGo = r; });
        let entered!: () => void;
        const inHeldRead = new Promise<void>(r => { entered = r; });
        const real = storage.getProject.bind(storage);
        let calls = 0;
        spies.push(vi.spyOn(storage, 'getProject').mockImplementation(async (id: string) => {
          if (id === pid && ++calls === heldCall) { entered(); await held; return stale; }
          return real(id);
        }));
        let queuedForProject!: () => void;
        const queued = new Promise<'queued'>(r => { queuedForProject = () => r('queued'); });
        const second = acquireSuiteRun(pid, (_w, line) => { if (/exclusiveSuite/.test(line)) queuedForProject(); });
        await inHeldRead;
        expect((await agent().put(`/projects/${pid}`).send({ exclusiveSuite: true })).status).toBe(200);
        letGo();
        const outcome = await Promise.race([queued, second.then(r => { releases.push(r); return 'started' as const; })]);
        expect(outcome, 'the second run started while the first was still going').toBe('queued');
        releases.shift()!();
        releases.push(await second);
      } finally {
        for (const r of releases) r();
        for (const sp of spies) sp.mockRestore();
        await agent().put('/settings').send({ maxConcurrentSuiteRuns: 0 });
      }
    });
  }

  it("the line a run waiting for its project prints names the project's setting, not the server's", async () => {
    const { projectWaitingLine } = await slotsModule();
    const line = projectWaitingLine({ ahead: 1, limit: 1 });
    expect(line).toMatch(/1 run\(s\) ahead/);
    expect(line).toMatch(/exclusiveSuite/);
    expect(line).not.toMatch(/maxConcurrentSuiteRuns/);
  });
});
