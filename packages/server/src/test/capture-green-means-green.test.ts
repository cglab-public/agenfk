/**
 * @file 001aed1e — a capture is green only when its report says so.
 *
 * Found on horizon-lab (2026-09-28): a test report command joining its suites
 * with `;` exits with the LAST suite's code, so a run whose report held two
 * failures exited 0. The server judged green by the exit code alone, indexed
 * that run as the tree content's green, and every later verify at the same
 * content reused it ("already tested green") and re-judged the same red
 * report: no retry could clear it.
 *
 * A capture is green only when the command exited 0 AND its report has no
 * failed test and no test file that failed to load. A red one is never
 * reused, never shared with a card waiting on it, never called green.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./capture-green-means-green-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { capturedGreen, describeCapture } from '../checkEngine';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });

const PASS = '<testsuites><testsuite name="s"><testcase classname="t" name="adds numbers" file="t.test.js"/></testsuite></testsuites>';
const FAIL = '<testsuites><testsuite name="s"><testcase classname="t" name="adds numbers" file="t.test.js"><failure message="expected 3">expected 3</failure></testcase></testsuite></testsuites>';

/**
 * A repo whose report command writes the report named in a mode file OUTSIDE
 * the tree, and always exits 0 - a masked exit, as `a; b` gives. Each run is
 * counted outside the tree too, so changing the mode never changes the tree.
 */
async function setup(opts: { commit?: boolean } = {}) {
  const f = await agent().post('/flows').send({ name: `cg-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-cg-repo-');
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  if (!opts.commit) fs.writeFileSync(path.join(repo, 'notes.txt'), 'mid-edit\n');
  const outside = tmp('agenfk-cg-ctl-');
  const mode = path.join(outside, 'mode');
  const runs = path.join(outside, 'runs');
  fs.writeFileSync(mode, 'fail');
  const runner = path.join(outside, 'runner.js');
  fs.writeFileSync(runner, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(runs)}, 'run\\n');
fs.writeFileSync('report.xml', fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() === 'pass' ? ${JSON.stringify(PASS)} : ${JSON.stringify(FAIL)});
process.exit(0);`);
  const p = await agent().post('/projects').send({ name: `cg-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const card = async () => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `cg-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    return c.body.id as string;
  };
  const count = () => fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length;
  return { card, count, pass: () => fs.writeFileSync(mode, 'pass') };
}
const capture = (id: string) => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});

describe('capturedGreen', () => {
  const rec = (x: Record<string, unknown>) => ({ kind: 'capture', available: true, exitCode: 0, tests: [{ name: 'a', status: 'passed' }], ...x });

  it('is green for exit 0 with every test passing', () => {
    expect(capturedGreen(rec({}))).toBe(true);
  });

  it('is not green when the report records a failed test, whatever the exit code', () => {
    expect(capturedGreen(rec({ tests: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }] }))).toBe(false);
  });

  it('is not green when a test file failed to load', () => {
    expect(capturedGreen(rec({ brokenFiles: [{ file: 'x.test.js', message: 'SyntaxError' }] }))).toBe(false);
  });

  it('is not green on a non-zero exit, or with no exit code (killed)', () => {
    expect(capturedGreen(rec({ exitCode: 1 }))).toBe(false);
    expect(capturedGreen(rec({ exitCode: null }))).toBe(false);
  });

  it('with no per-test report, the exit code alone decides', () => {
    expect(capturedGreen({ kind: 'capture', available: false, exitCode: 0 })).toBe(true);
    expect(capturedGreen({ kind: 'capture', available: false, exitCode: 2 })).toBe(false);
  });
});

describe('describeCapture never calls a red report green', () => {
  it('says "tested" without "green" for a reused run whose report failed', () => {
    const line = describeCapture({ kind: 'capture', available: true, exitCode: 0, tests: [{ name: 'b', status: 'failed' }], reusedFrom: { itemId: 'abcdef12', step: 'WORK', at: 'then' } });
    expect(line).toMatch(/already tested/);
    expect(line).not.toMatch(/green/);
  });
});

describe('a red capture with a masked exit is never reused', () => {
  it('a card capturing again at the same dirty state re-runs the suite, and passes once the tests do', async () => {
    const t = await setup();
    const a = await t.card();
    const first = await capture(a);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.exitCode).toBe(0);
    expect(first.body.tests.some((x: any) => x.status === 'failed')).toBe(true);
    t.pass();
    const again = await capture(a);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(t.count()).toBe(2);
    expect(again.body.reusedFrom).toBeUndefined();
    expect(again.body.tests.every((x: any) => x.status === 'passed')).toBe(true);
  });

  it("another card at the same state does not inherit the red run", async () => {
    const t = await setup();
    expect((await capture(await t.card())).status).toBe(200);
    const b = await capture(await t.card());
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(t.count()).toBe(2);
    expect(b.body.reusedFrom).toBeUndefined();
  });

  it('on a clean tree, a red run at the same commit is not reused either', async () => {
    const t = await setup({ commit: true });
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    const again = await capture(a);
    expect(t.count()).toBe(2);
    expect(again.body.reusedFrom).toBeUndefined();
  });

  it('a green run is still reused: the fix does not re-run what passed', async () => {
    const t = await setup();
    t.pass();
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    const again = await capture(a);
    expect(t.count()).toBe(1);
    expect(again.body.reusedFrom).toMatchObject({ itemId: a });
  });
});
