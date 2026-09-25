/**
 * @file 5a8d22e6 — a missing test report is the agent's to fix, not a person's to override.
 *
 * User 2026-09-25: "why didn't you automatically react to the need to add a
 * report setting. Is this an agenfk issue?" It was: a verify on a step whose
 * checks need per-test results repeated one long hint per check, with a
 * placeholder id and no command, and nothing told the agent to fix it. The
 * refusal now carries ONE actionable line, error code NO_TEST_REPORT, and a
 * ready-to-run command built from the project's real id and verify command.
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

const TEST_DB = path.resolve('./no-test-report-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { suggestTestReport } from '../testReportHint';

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
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A card on TESTS, whose checks need per-test results, in a project with no test report. */
async function setup(verifyCommand: string, gitignore = '.agenfk/\n') {
  const f = await agent().post('/flows').send({ name: `ntr-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }),
    s('TESTS', 1, { checks: [{ id: 'new-tests-exist' }, { id: 'some-new-test-red' }, { id: 'existing-tests-still-green' }] }),
    s('WORK', 2), s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ntr-'));
  dirs.push(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), gitignore);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `ntr-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `ntr-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'TESTS' } as any);
  return { id: c.body.id as string, pid: p.body.id as string, repo };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });

describe('5a8d22e6: the refusal says NO_TEST_REPORT once, with the command that fixes it', () => {
  it('names the error, and gives a ready command built from the real project id and verify command', async () => {
    // A stand-in that names vitest without running a suite here: the capture still runs it.
    const t = await setup('echo vitest run');
    const res = await validate(t.id);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('NO_TEST_REPORT');
    expect(res.body.fix).toBe(`agenfk update-project ${t.pid} --test-report-format vitest-json --test-report-command "echo vitest run --reporter=default --reporter=json --outputFile.json=.agenfk/test-report.json" --test-report-path .agenfk/test-report.json`);
    expect(res.body.message).toContain(res.body.fix);
  });

  it('says it once: no check repeats the placeholder hint', async () => {
    const t = await setup('echo vitest run');
    const res = await validate(t.id);
    expect(res.body.message.split('NO_TEST_REPORT').length - 1).toBe(1);
    expect(res.body.message).not.toContain('agenfk update-project <id>');
  });

  it('tells the agent to set it and verify again, not to ask a person for an override', async () => {
    const t = await setup('echo vitest run');
    const res = await validate(t.id);
    expect(res.body.message).toMatch(/run the same agenfk verify again/i);
  });

  it('warns when the suggested report path is not git-ignored: a report in the tree dirties it', async () => {
    const t = await setup('echo vitest run', 'node_modules/\n');
    const res = await validate(t.id);
    expect(res.body.message).toMatch(/\.agenfk\/test-report\.json is not ignored by git/);
  });

  it('says nothing about .gitignore when git cannot answer (not a repository)', async () => {
    const t = await setup('echo vitest run', 'node_modules/\n');
    fs.rmSync(path.join(t.repo, '.git'), { recursive: true, force: true });
    const res = await validate(t.id);
    expect(res.body.message).toContain('NO_TEST_REPORT');
    expect(res.body.message).not.toMatch(/is not ignored by git/);
  });

  it('is not raised when the project has a test report (the checks are judged on it)', async () => {
    const t = await setup('echo vitest run');
    await storage.updateProject(t.pid, { testReport: { format: 'junit-xml', command: 'true', reportPath: 'report.xml' } } as never);
    const res = await validate(t.id);
    expect(res.body.error).not.toBe('NO_TEST_REPORT');
  });
});

describe('5a8d22e6 review: held where the fix still works', () => {
  /** PLAN -> TESTS, whose checks read a per-test entry baseline, in a project with no report. */
  async function entering(check: Record<string, unknown> = { id: 'new-tests-exist' }) {
    const f = await agent().post('/flows').send({ name: `ntr-in-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('PLAN', 1), s('TESTS', 2, { checks: [check] }), s('END', 3, { isAnchor: true }),
    ] });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ntr-in-'));
    dirs.push(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'report.xml\n');
    execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
    const p = await agent().post('/projects').send({ name: `ntr-in-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'echo vitest run' } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: `ntr-in-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'PLAN' } as any);
    return { id: c.body.id as string, pid: p.body.id as string, repo };
  }

  it('refuses to ENTER a step that judges tests against a per-test baseline the project cannot record', async () => {
    const t = await entering();
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe('NO_TEST_REPORT');
    expect((res.body.checks as any[]).find(c => c.id === 'entry-baseline')).toMatchObject({ blocking: true });
  });

  it('with the report set, the card enters with a per-test baseline its next step can judge', async () => {
    const t = await entering();
    expect((await validate(t.id)).status).toBe(422);
    const runner = path.join(t.repo, '..', `ntr-runner-${seq}.js`);
    dirs.push(runner);
    fs.writeFileSync(runner, `require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="ok" file="t.test.js"/></testsuite></testsuites>');`);
    await storage.updateProject(t.pid, { testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entry = ((await agent().get(`/items/${t.id}`)).body.stepRecords ?? []).filter((r: any) => r.kind === 'capture' && r.step === 'PLAN').pop();
    expect(entry).toMatchObject({ available: true });
  });

  it('does not hold the card for per-test checks that would only warn there (review 2)', async () => {
    const t = await entering({ id: 'new-tests-born-green' });
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('a person can pass the hold with a reason, for a runner that cannot write a report (review 2)', async () => {
    const t = await entering();
    expect((await validate(t.id)).status).toBe(422);
    const o = await agent().post(`/items/${t.id}/overrides`).set({ 'x-agenfk-ui': '1' }).send({ checkId: 'entry-baseline', reason: 'cargo test: no JUnit here' });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('carries error and fix through a background run too (the CLI follows those)', async () => {
    const t = await entering();
    const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status, JSON.stringify(v.body)).toBe(202);
    let run: any = null;
    for (let i = 0; i < 200 && (!run || run.status === 'running'); i++) {
      run = (await agent().get(`/items/validate-runs/${v.body.runId}`).set(internal())).body;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(run).toMatchObject({ status: 'failed', error: 'NO_TEST_REPORT' });
    expect(run.fix).toMatch(/^agenfk update-project /);
  });
});

describe('5a8d22e6 review: an override given before the wording changed still counts', () => {
  it('lifts the check when its override was given against the old no-report detail', async () => {
    const t = await setup('echo vitest run');
    const legacy = 'per-test results are unavailable: this project has no test report set (agenfk update-project <id> --test-report-format vitest-json|junit-xml ...), so only the exit code is known';
    const at = new Date().toISOString();
    await storage.updateItem(t.id, { stepRecords: ['new-tests-exist', 'some-new-test-red', 'existing-tests-still-green'].map((check, i) => ({ id: `o${i}`, step: 'TESTS', kind: 'override', check, by: 'board', at, reason: 'no report yet', detail: legacy })) } as any);
    const res = await validate(t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = (await agent().get(`/items/${t.id}`)).body;
    const exit = (card.stepRecords ?? []).find((r: any) => r.kind === 'exit' && r.step === 'TESTS');
    expect((exit.checks as any[]).filter(c => c.overridden).map(c => c.id).sort()).toEqual(['existing-tests-still-green', 'new-tests-exist', 'some-new-test-red']);
  });
});

describe('suggestTestReport', () => {
  it('vitest, directly or through npx', () => {
    expect(suggestTestReport('npx vitest run', {})).toEqual({ format: 'vitest-json', command: 'npx vitest run --reporter=default --reporter=json --outputFile.json=.agenfk/test-report.json', reportPath: '.agenfk/test-report.json' });
    expect(suggestTestReport('vitest run', {})?.format).toBe('vitest-json');
  });
  it('npm test whose script is vitest: flags after --', () => {
    expect(suggestTestReport('npm test', { test: 'vitest run' })?.command).toBe('npm test -- --reporter=default --reporter=json --outputFile.json=.agenfk/test-report.json');
    expect(suggestTestReport('npm run test:unit', { 'test:unit': 'vitest' })?.command).toBe('npm run test:unit -- --reporter=default --reporter=json --outputFile.json=.agenfk/test-report.json');
  });
  it('suggests nothing where the flags would not reach the runner (review)', () => {
    // npm appends to the END of the script: here, to eslint.
    expect(suggestTestReport('npm test', { test: 'vitest run && eslint .' })).toBeNull();
    // Flags after a `--` already there are set aside by vitest.
    expect(suggestTestReport('npm test -- --run', { test: 'vitest' })).toBeNull();
    expect(suggestTestReport('vitest run -- foo', {})).toBeNull();
    // A pipe or `;` takes the flags elsewhere; a `cd` moves where the report lands.
    expect(suggestTestReport('vitest run | tee log', {})).toBeNull();
    expect(suggestTestReport('vitest run; echo done', {})).toBeNull();
    expect(suggestTestReport('cd web && npx vitest run', {})).toBeNull();
    // pnpm's handling of `--` is not certain enough to promise.
    expect(suggestTestReport('pnpm test', { test: 'vitest' })).toBeNull();
  });
  it('a build first, then the tests: the flags go on the part that runs them', () => {
    expect(suggestTestReport('npm run build && npm test', { build: 'tsc', test: 'vitest' })?.command).toBe('npm run build && npm test -- --reporter=default --reporter=json --outputFile.json=.agenfk/test-report.json');
    expect(suggestTestReport('npm run build && make lint', { build: 'tsc' })).toBeNull();
  });
  it('node --test with files: the flags go before the files, where node still reads them (review 2)', () => {
    expect(suggestTestReport('node --test test/a.test.js', {})?.command).toBe('node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=.agenfk/test-report.xml test/a.test.js');
    // npm appends to the end of `node --test test/`: after the files, so nothing certain.
    expect(suggestTestReport('npm test', { test: 'node --test test/' })).toBeNull();
    expect(suggestTestReport('npm test', { test: 'node --test' })?.format).toBe('junit-xml');
  });
  it('a workspace or prefix runs another package.json: nothing certain (review 2)', () => {
    expect(suggestTestReport('npm test -w web', { test: 'vitest' })).toBeNull();
    expect(suggestTestReport('npm test --workspace=web', { test: 'vitest' })).toBeNull();
    expect(suggestTestReport('npm --prefix web test', { test: 'vitest' })).toBeNull();
  });
  it('pytest writes JUnit XML', () => {
    expect(suggestTestReport('pytest -q', {})).toEqual({ format: 'junit-xml', command: 'pytest -q --junitxml=.agenfk/test-report.xml', reportPath: '.agenfk/test-report.xml' });
  });
  it('node --test writes JUnit XML through its reporter', () => {
    expect(suggestTestReport('node --test', {})).toEqual({ format: 'junit-xml', command: 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=.agenfk/test-report.xml', reportPath: '.agenfk/test-report.xml' });
  });
  it('makes nothing up for a runner it does not know', () => {
    expect(suggestTestReport('make check', {})).toBeNull();
    expect(suggestTestReport('npm test', { test: 'jest' })).toBeNull();
  });
});
