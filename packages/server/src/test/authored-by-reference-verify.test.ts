/**
 * authoredTests by reference, through a real verify (BUG ec325925, epic
 * review). The record is stored as {fromCapture, excluded} plus its capture's
 * results; the server expands it to names before the engine runs. Unit tests
 * covered the two halves; this walks a card through the step that writes tests
 * and the coding step, so reverting the server's reader - the engine then gets
 * the reference object, which it read as "no record" and passed soft - turns
 * this red. A reference whose results cannot be read holds the card.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./authored-by-reference-verify-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

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

/** Test files hold `pass NAME` / `fail NAME` lines; the runner reports every test file in the tree. */
const RUNNER = `
const fs = require('fs'), path = require('path');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk('.').map(f => path.relative('.', f)).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
const cases = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).map(l => {
  const [st, ...n] = l.split(' ');
  if (st === 'fail') failed++;
  return '<testcase classname="t" name="' + n.join(' ') + '" file="' + f + '">' + (st === 'fail' ? '<failure message="expected 1 to be 2" type="AssertionError"/>' : '') + '</testcase>';
}));
fs.writeFileSync('report.xml', '<testsuites><testsuite name="s">' + cases.join('') + '</testsuite></testsuites>');
process.exit(failed ? 1 : 0);
`;

/** START -> PLAN -> TESTS (writes the tests) -> WORK (count since the tests were written) -> END. */
const FLOW = () => [
  s('START', 0, { isAnchor: true }), s('PLAN', 1),
  s('TESTS', 2, { checks: [{ id: 'new-tests-exist' }, { id: 'some-new-test-red' }] }),
  s('WORK', 3, { checks: [{ id: 'test-count-not-lower', params: { since: 'test-authoring' } }] }),
  s('END', 4, { isAnchor: true }),
];

async function cardOnWork() {
  const f = await agent().post('/flows').send({ name: `abr-${++seq}`, steps: FLOW() });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-abr-repo-');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass keeps working\npass old behaviour\n');
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  const runner = path.join(tmp('agenfk-abr-tools-'), 'runner.js');
  fs.writeFileSync(runner, RUNNER);
  const p = await agent().post('/projects').send({ name: `abr-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `abr-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
  const write = (text: string) => fs.writeFileSync(path.join(repo, 'a.test.js'), text);
  const validate = () => agent().post(`/items/${c.body.id}/validate`).set(internal()).send({ evidence: 'ok' });

  expect((await validate()).status).toBe(200); // PLAN -> TESTS, its entry baseline taken
  write('pass keeps working\npass old behaviour\nfail new behaviour\n');
  const r = await validate(); // TESTS -> WORK, authoredTests recorded
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id: c.body.id as string, write, validate };
}
const result = (body: any, id: string) => (body.checks ?? []).find((c: any) => c.id === id);

describe('authoredTests stored by reference, judged in a real verify', () => {
  it('is stored as a reference to its capture, not a copy of the names', async () => {
    const t = await cardOnWork();
    const rec = ((await storage.getItem(t.id)) as any).stepRecords.find((r: any) => r.name === 'authoredTests');
    expect(rec.value).toEqual({ fromCapture: true, excluded: [] });
    expect(rec.tests.map((x: any) => x.name)).toEqual(['a.test.js > keeps working', 'a.test.js > old behaviour', 'a.test.js > new behaviour']);
  });

  it('still holds a card that deletes a test that existed before the tests were written', async () => {
    const t = await cardOnWork();
    t.write('pass keeps working\npass new behaviour\n');
    const r = await t.validate();
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const c = result(r.body, 'test-count-not-lower');
    expect(c.outcome).toBe('fail');
    expect(c.blocking).toBe(true);
    expect(c.detail).toMatch(/old behaviour/);
  });

  it('lets a card through that kept every test', async () => {
    const t = await cardOnWork();
    t.write('pass keeps working\npass old behaviour\npass new behaviour\n');
    const r = await t.validate();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(((await storage.getItem(t.id)) as any).lastChecks.results.find((c: any) => c.id === 'test-count-not-lower')?.outcome).toBe('pass');
  });

  it('holds the card when the reference\'s results can no longer be read, rather than passing it soft', async () => {
    const t = await cardOnWork();
    const item: any = await storage.getItem(t.id);
    const broken = item.stepRecords.map((r: any) => (r.name === 'authoredTests' ? { ...r, tests: undefined, testsMissing: true } : r));
    await (storage as any).rewriteRecords(t.id, { stepRecords: broken.map(({ tests, testsMissing, ...r }: any) => (r.name === 'authoredTests' ? r : { ...r, tests })) });
    t.write('pass keeps working\npass new behaviour\n');
    const r = await t.validate();
    const c = result(r.body, 'test-count-not-lower');
    expect(c.outcome).toBe('unavailable');
    expect(c.blocking).toBe(true);
    expect(c.detail).toMatch(/can no longer be read/);
  });

  it('keeps one capture of a step however many times its verify is refused (the server prunes on write)', async () => {
    const t = await cardOnWork();
    t.write('pass keeps working\npass new behaviour\n');
    for (let i = 0; i < 3; i++) expect((await t.validate()).status).toBe(422);
    const caps = ((await storage.getItem(t.id)) as any).stepRecords.filter((r: any) => r.kind === 'capture' && r.step === 'WORK');
    expect(caps).toHaveLength(1);
  });
});
