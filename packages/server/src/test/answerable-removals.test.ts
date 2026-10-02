/**
 * @file e2ab4ced — removing tests while changing behaviour is answered, not banned.
 *
 * Field report (2026-09-28): changing a behaviour, an agent had to delete two
 * tests that pinned the old one; test-count-not-lower refused, so it kept
 * their names and repointed them at another case - hiding the change, which
 * is worse than deleting them. Now a lower count still holds the card and
 * names the tests, until the agent says why: --check-note <check>="...".
 * A red test renamed or removed (red-set-passes-by-name) is the card's own
 * specification, and only a person passes that, on the board (6dd15e6e). The answer goes on
 * the record, to the reviewer (tree-warnings) and the PR. A red test that
 * still FAILS is never answered away, and a refactoring step - where
 * behaviour must not change - stays strict.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('answerable-removals-test-db.sqlite');
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

async function project(steps: any[], start: string) {
  const f = await agent().post('/flows').send({ name: `ar-${++seq}`, steps });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-ar-repo-');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass keeps working\npass old behaviour\n');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  const runner = path.join(tmp('agenfk-ar-tools-'), 'runner.js');
  fs.writeFileSync(runner, RUNNER);
  const p = await agent().post('/projects').send({ name: `ar-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `ar-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: start } as any);
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  return { id: c.body.id as string, repo, write };
}
const validate = (id: string, checkAnswers?: Array<{ id: string; note: string }>) =>
  agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...(checkAnswers ? { checkAnswers } : {}) });
const statusOf = async (id: string) => ((await storage.getItem(id)) as any).status;
const result = (body: any, id: string) => (body.checks ?? []).find((c: any) => c.id === id);

/** START -> PLAN -> WORK (test-count-not-lower since the step began, role as given) -> END. */
const countFlow = (role?: string) => [
  s('START', 0, { isAnchor: true }), s('PLAN', 1),
  s('WORK', 2, { ...(role ? { role } : {}), checks: [{ id: 'test-count-not-lower', params: { since: 'step-entry' } }] }),
  s('END', 3, { isAnchor: true }),
];

describe('test-count-not-lower: a removal is answered with a reason', () => {
  it('holds the card, naming the tests that went and how to answer', async () => {
    const t = await project(countFlow(), 'PLAN');
    expect((await validate(t.id)).status).toBe(200);
    t.write('a.test.js', 'pass keeps working\n');
    const r = await validate(t.id);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const c = result(r.body, 'test-count-not-lower');
    expect(c.blocking).toBe(true);
    expect(c.detail).toMatch(/old behaviour/);
    expect(r.body.message).toMatch(/--check-note test-count-not-lower=/);
  });

  it('an answer lets it leave, and the reviewer sees the removal and the answer', async () => {
    const t = await project(countFlow(), 'PLAN');
    expect((await validate(t.id)).status).toBe(200);
    t.write('a.test.js', 'pass keeps working\n');
    const r = await validate(t.id, [{ id: 'test-count-not-lower', note: 'pinned the old behaviour this card replaces' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusOf(t.id)).toBe('END');
    const warnings = (await agent().get(`/items/${t.id}/warnings`)).body;
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      step: 'WORK', check: 'test-count-not-lower', answer: 'pinned the old behaviour this card replaces', detail: expect.stringMatching(/old behaviour/),
    })]));
  });

  it('stays strict on a refactoring step: an answer does not lift it', async () => {
    const t = await project(countFlow('refactoring'), 'PLAN');
    expect((await validate(t.id)).status).toBe(200);
    t.write('a.test.js', 'pass keeps working\n');
    const r = await validate(t.id, [{ id: 'test-count-not-lower', note: 'no longer needed' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(result(r.body, 'test-count-not-lower').blocking).toBe(true);
  });
});

/** START -> SPECS (test-authoring: records the red set) -> BUILD (coding) -> END. */
const tddFlow = () => [
  s('START', 0, { isAnchor: true }), s('SPECS', 1, { role: 'test-authoring' }), s('BUILD', 2, { role: 'coding' }), s('END', 3, { isAnchor: true }),
];
async function intoBuildWithRed(t: Awaited<ReturnType<typeof project>>) {
  expect((await validate(t.id)).status).toBe(200); // START -> SPECS, entry recorded
  t.write('b.test.js', 'fail new rule\n');
  const r = await validate(t.id);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await statusOf(t.id)).toBe('BUILD');
}

describe('red-set-passes-by-name: a red test renamed or removed is answered with a reason', () => {
  // 6dd15e6e: was answerable (e2ab4ced). The red set is the card's own specification: a person passes a rename.
  it('holds the card when a red test is renamed, and an agent\'s answer does not lift it', async () => {
    const t = await project(tddFlow(), 'START');
    await intoBuildWithRed(t);
    t.write('b.test.js', 'pass new rule, clearer name\n');
    const held = await validate(t.id);
    expect(held.status, JSON.stringify(held.body)).toBe(422);
    expect(result(held.body, 'red-set-passes-by-name').detail).toMatch(/new rule \[missing\]/);
    expect(held.body.message).not.toMatch(/--check-note red-set-passes-by-name=/);
    const r = await validate(t.id, [{ id: 'red-set-passes-by-name', note: 'renamed to say what the rule is' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(result(r.body, 'red-set-passes-by-name').blocking).toBe(true);
  });

  it('a red test that still fails is never answered away', async () => {
    const t = await project(tddFlow(), 'START');
    await intoBuildWithRed(t);
    const r = await validate(t.id, [{ id: 'red-set-passes-by-name', note: 'will fix later' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(result(r.body, 'red-set-passes-by-name').blocking).toBe(true);
  });

  it('an answer for a renamed red test does not lift one that still fails beside it', async () => {
    const t = await project(tddFlow(), 'START');
    expect((await validate(t.id)).status).toBe(200);
    t.write('b.test.js', 'fail new rule\nfail second rule\n');
    expect((await validate(t.id)).status).toBe(200);
    t.write('b.test.js', 'pass new rule, clearer name\nfail second rule\n');
    const r = await validate(t.id, [{ id: 'red-set-passes-by-name', note: 'renamed the first' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(result(r.body, 'red-set-passes-by-name').blocking).toBe(true);
  });
});

/*
 * 6dd15e6e (review of 6caae168, finding 5): the red set is the card's own
 * specification. Deleting it on the coding step and answering both removal
 * checks let a card leave without building anything. Only a person passes it.
 */
describe('red-set-passes-by-name: the card\'s own red tests are not answered away by the agent', () => {
  it('every red test deleted, both removal checks answered: the card is held, and told a person must pass it', async () => {
    const t = await project(tddFlow(), 'START');
    await intoBuildWithRed(t);
    fs.rmSync(path.join(t.repo, 'b.test.js'));
    const r = await validate(t.id, [
      { id: 'red-set-passes-by-name', note: 'no longer needed' },
      { id: 'test-count-not-lower', note: 'no longer needed' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const red = result(r.body, 'red-set-passes-by-name');
    expect(red.blocking).toBe(true);
    expect(red.detail).not.toMatch(/--check-note/);
    expect(red.detail).toMatch(/a person .*override .*board/i);
  });
});

