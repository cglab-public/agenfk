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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./suite-slots-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
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
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
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
}, 400);`);
  const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });
  const cards: string[] = [];
  for (let i = 0; i < 2; i++) {
    const f = await agent().post('/flows').send({ name: `slots-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-slots-repo-')));
    dirs.push(repo);
    execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
    const p = await agent().post('/projects').send({ name: `slots-${++seq}` });
    await storage.updateProject(p.body.id, {
      flowId: f.body.id, projectRoot: repo,
      verifyCommand: kind === 'final' ? `node ${runner}` : 'true',
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

describe('suite runs across projects take a slot', () => {
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
