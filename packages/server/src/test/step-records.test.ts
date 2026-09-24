/**
 * @file CGLAB-379 (S3) — step records on the card, the test-report setting,
 * and on-demand capture.
 *
 * User decisions (2026-09-23): every forward verify records the cheap part
 * (the step left, HEAD, whether the tree was clean); a test report is captured
 * only when a check asks for one (S4 drives the capture endpoint); the report
 * comes from an explicit project setting, token-gated like verifyCommand and
 * logged the same way. Unset, capture falls back to the exit code alone — per
 * test results are then UNAVAILABLE, never "passed".
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

const TEST_DB = path.resolve('./step-records-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Import AFTER the env var so storage lands in the test DB.
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { bindRoleLessDefaultFlow } from './helpers/roleLessFlow';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/** A clean git repo with one test file committed. */
function makeRepo(): { dir: string; sha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-steprec-'));
  repos.push(dir);
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return { dir, sha: execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim() };
}

let seq = 0;
async function project(extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `steprec-${++seq}` });
  expect(p.status).toBe(201);
  await bindRoleLessDefaultFlow(storage, p.body.id);
  if (Object.keys(extra).length) await storage.updateProject(p.body.id, extra as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
const recordsOf = async (id: string) => {
  const res = await agent().get(`/items/${id}/step-records`).set(internal());
  expect(res.status, `step-records: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });

// A command that writes a vitest-style JSON report naming tests/a.test.js.
const vitestReportCommand = (status: 'passed' | 'failed') =>
  `node -e "require('fs').writeFileSync('report.json', JSON.stringify({testResults:[{name:require('path').resolve('tests/a.test.js'),status:'${status}',message:'',assertionResults:[{fullName:'a works',status:'${status}',failureMessages:${status === 'failed' ? "['AssertionError: nope']" : '[]'}}]}]}))"`;

describe('CGLAB-379: step records', () => {
  beforeEach(async () => { await initStorage(); });

  describe('every forward verify records the step it left', () => {
    it('with HEAD and a clean tree', async () => {
      const { dir, sha } = makeRepo();
      const id = await card(await project({ projectRoot: dir }), 'IN_PROGRESS');
      expect((await validate(id)).status).toBe(200);
      const recs = await recordsOf(id);
      const last = recs[recs.length - 1];
      expect(last).toMatchObject({ step: 'IN_PROGRESS', kind: 'exit', head: sha, clean: true });
      expect(last.at).toBeTruthy();
    });

    it('marks a dirty tree as not clean', async () => {
      const { dir } = makeRepo();
      fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'edited');
      const id = await card(await project({ projectRoot: dir }), 'IN_PROGRESS');
      await validate(id);
      const recs = await recordsOf(id);
      expect(recs[recs.length - 1]).toMatchObject({ step: 'IN_PROGRESS', clean: false });
    });

    it('still records the step when the project has no root', async () => {
      const id = await card(await project(), 'IN_PROGRESS');
      await validate(id);
      const recs = await recordsOf(id);
      expect(recs[recs.length - 1]).toMatchObject({ step: 'IN_PROGRESS', kind: 'exit', head: null });
    });

    it('cannot be written by a caller through PUT /items/:id', async () => {
      const id = await card(await project(), 'IN_PROGRESS');
      await agent().put(`/items/${id}`).send({ stepRecords: [{ step: 'REVIEW', kind: 'exit', head: 'forged' }] });
      expect(await recordsOf(id)).toEqual([]);
    });

    it('drops the records of every step a card is moved back over', async () => {
      const id = await card(await project(), 'REVIEW');
      await storage.updateItem(id, { stepRecords: [
        { step: 'TODO', kind: 'exit', head: null, clean: false, at: 't1' },
        { step: 'IN_PROGRESS', kind: 'exit', head: null, clean: false, at: 't2' },
      ] } as any);
      expect((await agent().put(`/items/${id}`).send({ status: 'IN_PROGRESS' })).status).toBe(200);
      expect((await recordsOf(id)).map((r: any) => r.step)).toEqual(['TODO']);
    });

    it('writes a record when a card leaves TODO too', async () => {
      const id = await card(await project(), 'TODO');
      expect((await validate(id)).status).toBe(200);
      expect((await recordsOf(id)).map((r: any) => [r.step, r.kind])).toEqual([['TODO', 'exit']]);
    });

    it('drops them on a move back through PAUSED, judged from the step the card was paused at', async () => {
      const id = await card(await project(), 'REVIEW');
      await storage.updateItem(id, { stepRecords: [
        { step: 'TODO', kind: 'exit', head: null, clean: false, at: 't1' },
        { step: 'IN_PROGRESS', kind: 'exit', head: null, clean: false, at: 't2' },
      ] } as any);
      expect((await agent().put(`/items/${id}`).send({ status: 'PAUSED' })).status).toBe(200);
      expect((await agent().put(`/items/${id}`).send({ status: 'IN_PROGRESS' })).status).toBe(200);
      expect((await recordsOf(id)).map((r: any) => r.step)).toEqual(['TODO']);
    });

    it('drops them on a move back through BLOCKED on the bulk route', async () => {
      const id = await card(await project(), 'TEST');
      await storage.updateItem(id, { stepRecords: [
        { step: 'IN_PROGRESS', kind: 'exit', head: null, clean: false, at: 't1' },
        { step: 'REVIEW', kind: 'exit', head: null, clean: false, at: 't2' },
      ] } as any);
      await agent().post('/items/bulk').send({ items: [{ id, updates: { status: 'BLOCKED' } }] });
      await agent().post('/items/bulk').send({ items: [{ id, updates: { status: 'IN_PROGRESS' } }] });
      expect(await recordsOf(id)).toEqual([]);
    });

    it('keeps them when a paused card returns to the step it was paused at', async () => {
      const id = await card(await project(), 'REVIEW');
      await storage.updateItem(id, { stepRecords: [{ step: 'IN_PROGRESS', kind: 'exit', head: null, clean: false, at: 't1' }] } as any);
      await agent().put(`/items/${id}`).send({ status: 'PAUSED' });
      await agent().put(`/items/${id}`).send({ status: 'REVIEW' });
      expect((await recordsOf(id)).map((r: any) => r.step)).toEqual(['IN_PROGRESS']);
    });

    it('needs the internal token to read', async () => {
      const id = await card(await project(), 'IN_PROGRESS');
      expect((await agent().get(`/items/${id}/step-records`)).status).toBe(401);
    });
  });

  describe('the testReport project setting', () => {
    it('needs the internal token', async () => {
      const p = await project();
      const res = await agent().put(`/projects/${p}/test-report`).send({ format: 'vitest-json', command: 'x', reportPath: 'r.json' });
      expect(res.status).toBe(401);
    });

    it('refuses an unknown format or a missing field', async () => {
      const p = await project();
      expect((await agent().put(`/projects/${p}/test-report`).set(internal()).send({ format: 'tap', command: 'x', reportPath: 'r' })).status).toBe(400);
      expect((await agent().put(`/projects/${p}/test-report`).set(internal()).send({ format: 'junit-xml', reportPath: 'r' })).status).toBe(400);
    });

    it('accepts extra surface paths', async () => {
      const p = await project();
      const setting = { format: 'vitest-json', command: 'x', reportPath: 'r.json', surface: ['tests/helpers', 'vitest.setup.ts'] };
      expect((await agent().put(`/projects/${p}/test-report`).set(internal()).send(setting)).status).toBe(200);
      expect((await agent().get(`/projects/${p}`)).body.testReport).toEqual(setting);
      const bad = await agent().put(`/projects/${p}/test-report`).set(internal()).send({ ...setting, surface: 'tests' });
      expect(bad.status).toBe(400);
    });

    it('stores it, clears it with null, and logs each change on the project and on cards in flight', async () => {
      const p = await project();
      const working = await card(p, 'IN_PROGRESS');
      const setting = { format: 'junit-xml', command: 'pytest --junitxml=report.xml', reportPath: 'report.xml' };
      expect((await agent().put(`/projects/${p}/test-report`).set(internal()).send(setting)).status).toBe(200);
      expect((await agent().get(`/projects/${p}`)).body.testReport).toEqual(setting);
      expect((await agent().put(`/projects/${p}/test-report`).set(internal()).send({ testReport: null })).status).toBe(200);
      const proj = (await agent().get(`/projects/${p}`)).body;
      expect(proj.testReport ?? null).toBeNull();
      expect(proj.testReportChanges).toHaveLength(2);
      const notes = ((await agent().get(`/items/${working}`)).body.comments ?? []).filter((c: any) => /test report/i.test(c.content));
      expect(notes).toHaveLength(2);
    });
  });

  describe('capture on demand', () => {
    it('needs the internal token', async () => {
      const id = await card(await project(), 'IN_PROGRESS');
      expect((await agent().post(`/items/${id}/step-records/capture`)).status).toBe(401);
    });

    it('runs the report command in the card\'s tree and records per-test results and the surface', async () => {
      const { dir, sha } = makeRepo();
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: vitestReportCommand('failed'), reportPath: 'report.json' } });
      const id = await card(p, 'CREATE_UNIT_TESTS');
      const res = await agent().post(`/items/${id}/step-records/capture`).set(internal());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ step: 'CREATE_UNIT_TESTS', kind: 'capture', head: sha, format: 'vitest-json', available: true });
      expect(res.body.tests).toEqual([{ name: 'tests/a.test.js > a works', file: 'tests/a.test.js', status: 'failed', failure: 'assertion' }]);
      expect(Object.keys(res.body.surface.files)).toContain('tests/a.test.js');
      expect(res.body.surfaceComplete).toBe(true);
      const recs = await recordsOf(id);
      expect(recs[recs.length - 1]).toMatchObject({ kind: 'capture', step: 'CREATE_UNIT_TESTS' });
    });

    it('records the report as unavailable - never passed - when it cannot be read', async () => {
      const { dir } = makeRepo();
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: 'true', reportPath: 'report.json' } });
      const id = await card(p, 'IN_PROGRESS');
      const res = await agent().post(`/items/${id}/step-records/capture`).set(internal());
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.tests).toBeUndefined();
      expect(res.body.parseError).toBeTruthy();
    });

    it('falls back to the verify command\'s exit code when no report is configured', async () => {
      const { dir } = makeRepo();
      const p = await project({ projectRoot: dir, verifyCommand: 'exit 3' });
      const id = await card(p, 'IN_PROGRESS');
      const res = await agent().post(`/items/${id}/step-records/capture`).set(internal());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ format: 'exit-code', exitCode: 3, available: false });
      expect(res.body.tests).toBeUndefined();
    });

    it('hashes the extra surface paths too', async () => {
      const { dir } = makeRepo();
      fs.mkdirSync(path.join(dir, 'tests/helpers'));
      fs.writeFileSync(path.join(dir, 'tests/helpers/fixture.js'), 'f');
      execSync('git add . && git commit -qm helpers', { cwd: dir, shell: '/bin/sh' });
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: vitestReportCommand('passed'), reportPath: 'report.json', surface: ['tests/helpers'] } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(Object.keys(res.body.surface.files)).toContain('tests/helpers/fixture.js');
    });

    it('marks the results unavailable when the tree changed while the command ran', async () => {
      const { dir } = makeRepo();
      const cmd = `node -e "require('fs').writeFileSync('tests/a.test.js','weakened')" && ${vitestReportCommand('passed')}`;
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: cmd, reportPath: 'report.json' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.parseError).toMatch(/changed/i);
    });

    it('marks the results unavailable when an UNTRACKED test file changed while the command ran', async () => {
      const { dir } = makeRepo();
      fs.writeFileSync(path.join(dir, 'tests/new.test.js'), 'red test');
      const report = `node -e "require('fs').writeFileSync('report.json', JSON.stringify({testResults:[{name:require('path').resolve('tests/new.test.js'),status:'passed',message:'',assertionResults:[{fullName:'n',status:'passed',failureMessages:[]}]}]}))"`;
      const cmd = `node -e "require('fs').writeFileSync('tests/new.test.js','weakened')" && ${report}`;
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: cmd, reportPath: 'report.json' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.body.available).toBe(false);
      expect(res.body.parseError).toMatch(/changed/i);
    });

    it('marks the results unavailable when the tree is not a git repository (it cannot be tied to one)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-nogit-'));
      repos.push(dir);
      fs.mkdirSync(path.join(dir, 'tests'));
      fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: vitestReportCommand('passed'), reportPath: 'report.json' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.body.available).toBe(false);
    });

    it('still detects an edit during the run under a large uncommitted diff', async () => {
      const { dir } = makeRepo();
      fs.writeFileSync(path.join(dir, 'big.txt'), 'x');
      execSync('git add big.txt && git commit -qm big', { cwd: dir, shell: '/bin/sh' });
      fs.writeFileSync(path.join(dir, 'big.txt'), 'y'.repeat(2 * 1024 * 1024));
      const cmd = `node -e "require('fs').writeFileSync('tests/a.test.js','weakened')" && ${vitestReportCommand('passed')}`;
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: cmd, reportPath: 'report.json' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.body.available).toBe(false);
    });

    it('leaves out only a name two tests share, keeping the rest of the report available', async () => {
      const { dir } = makeRepo();
      const cmd = `node -e "require('fs').writeFileSync('report.json', JSON.stringify({testResults:[{name:require('path').resolve('tests/a.test.js'),status:'failed',message:'',assertionResults:[{fullName:'x',status:'failed',failureMessages:['AssertionError']},{fullName:'x',status:'passed',failureMessages:[]},{fullName:'y',status:'passed',failureMessages:[]}]}]}))"`;
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: cmd, reportPath: 'report.json' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.body.available).toBe(true);
      expect(res.body.duplicateNames).toEqual(['tests/a.test.js > x']);
      expect(res.body.tests.map((t: any) => t.name)).toEqual(['tests/a.test.js > y']);
    });

    it('marks the surface incomplete when a file the report names cannot be found', async () => {
      const { dir } = makeRepo();
      const cmd = `node -e "require('fs').writeFileSync('report.xml','<testsuite><testcase classname=\\'nowhere.test_x\\' name=\\'t\\'/></testsuite>')"`;
      const p = await project({ projectRoot: dir, testReport: { format: 'junit-xml', command: cmd, reportPath: 'report.xml' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.body.available).toBe(true);
      expect(res.body.surfaceComplete).toBe(false);
    });

    it('discards the capture when the card moved while the command ran', async () => {
      const { dir } = makeRepo();
      const cmd = `sleep 1 && ${vitestReportCommand('passed')}`;
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: cmd, reportPath: 'report.json' } });
      const id = await card(p, 'IN_PROGRESS');
      const pending = agent().post(`/items/${id}/step-records/capture`).set(internal()).then(r => r);
      await new Promise(r => setTimeout(r, 300));
      await storage.updateItem(id, { status: 'TODO' } as any);
      const res = await pending;
      expect(res.status).toBe(409);
      expect((await recordsOf(id)).filter((r: any) => r.kind === 'capture')).toHaveLength(0);
    });

    it('never deletes or reads a report through a symlink out of the tree', async () => {
      const { dir } = makeRepo();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-outside-'));
      repos.push(outside);
      fs.writeFileSync(path.join(outside, 'report.json'), 'sentinel');
      fs.symlinkSync(outside, path.join(dir, 'out'));
      const p = await project({ projectRoot: dir, testReport: { format: 'vitest-json', command: 'true', reportPath: 'out/report.json' } });
      const res = await agent().post(`/items/${await card(p, 'IN_PROGRESS')}/step-records/capture`).set(internal());
      expect(res.body.available).toBe(false);
      expect(fs.existsSync(path.join(outside, 'report.json')), 'the capture deleted a file outside the tree').toBe(true);
      expect(fs.readFileSync(path.join(outside, 'report.json'), 'utf8')).toBe('sentinel');
    });

    it('kills the whole process group on a timeout, so no leftover worker writes later', async () => {
      const { dir } = makeRepo();
      const p = await project({ projectRoot: dir, verifyCommand: `(sleep 2; touch late.txt) & wait` });
      const id = await card(p, 'IN_PROGRESS');
      const before = process.env.AGENFK_VERIFY_MAX_MS;
      process.env.AGENFK_VERIFY_MAX_MS = '300';
      try {
        const res = await agent().post(`/items/${id}/step-records/capture`).set(internal());
        expect(res.status).toBe(200);
      } finally {
        if (before === undefined) delete process.env.AGENFK_VERIFY_MAX_MS; else process.env.AGENFK_VERIFY_MAX_MS = before;
      }
      await new Promise(r => setTimeout(r, 2500));
      expect(fs.existsSync(path.join(dir, 'late.txt'))).toBe(false);
    });

    it('refuses when there is nothing to run', async () => {
      const { dir } = makeRepo();
      const id = await card(await project({ projectRoot: dir }), 'IN_PROGRESS');
      const res = await agent().post(`/items/${id}/step-records/capture`).set(internal());
      expect(res.status).toBe(400);
    });

    it('refuses when the card has no tree to run in', async () => {
      const id = await card(await project({ verifyCommand: 'true' }), 'IN_PROGRESS');
      const res = await agent().post(`/items/${id}/step-records/capture`).set(internal());
      expect(res.status).toBe(400);
    });
  });
});
