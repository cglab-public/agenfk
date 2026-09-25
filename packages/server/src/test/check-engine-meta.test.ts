/**
 * @file CGLAB-380 (S4-T3) — the git/meta checks: jira-key-valid, has-children,
 * only-test-files-changed. (Engine mechanics are in check-engine.test.ts.)
 *
 * Shared harness below:
 *
 * verify resolves the step's checks (universal + role built-ins + flow extras),
 * runs them in the card's tree, and refuses the transition when a blocking one
 * fails, in the verify failure shape old clients already print (422 with a
 * message) plus `checks[]`. Warnings are recorded and never block. Results go
 * on the card. A test report is captured only when a check needs one, and a
 * capture also serves as the NEXT step's entry record, so no suite runs just to
 * snapshot a step's start.
 *
 * Every flow here is written with step names the server has never seen: the
 * engine must work from roles and records alone.
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

const TEST_DB = path.resolve('./check-engine-meta-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

function makeRepo(branch = 'main'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-engine-meta-'));
  repos.push(dir);
  execSync(`git init -q -b ${branch} && git config user.email t@t && git config user.name t`, { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

/** A JUnit report with `n` passing tests in tests/a.test.js. */
const junitCommand = (n: number) =>
  `printf '<testsuite>${Array.from({ length: n }, (_, i) => `<testcase file="tests/a.test.js" name="t${i}"/>`).join('')}</testsuite>' > report.xml`;

let seq = 0;
async function flow(steps: any[]): Promise<string> {
  const res = await agent().post('/flows').send({ name: `engine-${++seq}`, steps });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function project(flowId: string | null, extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `engine-${++seq}` });
  expect(p.status).toBe(201);
  await storage.updateProject(p.body.id, { ...(flowId ? { flowId } : {}), ...extra } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}, type = 'TASK') {
  const c = await agent().post('/items').send({ type, title: `card-${++seq}`, projectId });
  expect(c.status).toBe(201);
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string, body: Record<string, unknown> = {}) =>
  agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', ...body });
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
const byId = (checks: any[], id: string) => checks.find((c: any) => c.id === id);

const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
/** start (anchor) -> make (coding) -> check (review) -> end (anchor). */
const codingFlow = () => [s('START', 0, { isAnchor: true }), s('MAKE', 1, { role: 'coding' }), s('CHECK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })];


/** start -> plan (planning) -> work (planning + the check under test) -> end. */
const withCheck = (check: Record<string, unknown>) => [
  s('START', 0, { isAnchor: true }), s('PLAN', 1, { role: 'planning' }),
  s('WORK', 2, { role: 'planning', checks: [check] }), s('END', 3, { isAnchor: true }),
];

describe('CGLAB-380: git/meta checks', () => {
  describe('jira-key-valid', () => {
    const setup = async (branch: string, extra: Record<string, unknown>) => {
      const dir = makeRepo(branch);
      const pid = await project(await flow(withCheck({ id: 'jira-key-valid' })), { projectRoot: dir, verifyCommand: 'exit 0' });
      return { dir, pid };
    };

    it('passes for a card linked to a key its branch carries', async () => {
      const { pid } = await setup('feat/ABC-12_thing', {});
      const id = await card(pid, 'WORK', { externalId: 'ABC-12', branchName: 'feat/ABC-12_thing' });
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'jira-key-valid').outcome).toBe('pass');
    });

    it('fails for a card with no key, on it or above it', async () => {
      const { pid } = await setup('main', {});
      const id = await card(pid, 'WORK');
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'jira-key-valid')).toMatchObject({ outcome: 'fail' });
      expect(byId(res.body.checks, 'jira-key-valid').detail).toMatch(/no JIRA key/);
    });

    it('fails for a malformed key', async () => {
      const { pid } = await setup('main', {});
      const id = await card(pid, 'WORK', { externalId: 'not a key' });
      expect((await validate(id)).status).toBe(422);
    });

    it('a task takes the key of the story it belongs to', async () => {
      const { pid } = await setup('main', {});
      const parent = await card(pid, 'WORK', { externalId: 'ABC-7' }, 'STORY');
      const id = await card(pid, 'WORK', { parentId: parent });
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'jira-key-valid').detail).toMatch(/ABC-7/);
    });

    it('fails when the card\'s branch carries none of its keys', async () => {
      const { pid } = await setup('feat/other-thing', {});
      const id = await card(pid, 'WORK', { externalId: 'ABC-12', branchName: 'feat/other-thing' });
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'jira-key-valid').detail).toMatch(/ABC-12/);
      expect(byId(res.body.checks, 'jira-key-valid').detail).toMatch(/feat\/other-thing/);
    });
  });

  describe('has-children', () => {
    const setup = async () => {
      const dir = makeRepo();
      return project(await flow(withCheck({ id: 'has-children' })), { projectRoot: dir, verifyCommand: 'exit 0' });
    };

    it('refuses an EPIC with no children', async () => {
      const id = await card(await setup(), 'WORK', {}, 'EPIC');
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'has-children')).toMatchObject({ outcome: 'fail' });
    });

    it('passes an EPIC once it has a child', async () => {
      const pid = await setup();
      const id = await card(pid, 'WORK', {}, 'EPIC');
      await card(pid, 'TODO', { parentId: id }, 'STORY');
      expect((await validate(id)).status).toBe(200);
    });

    it('does not apply to card types it does not list', async () => {
      const id = await card(await setup(), 'WORK', {}, 'TASK');
      const res = await validate(id);
      expect(res.status).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'has-children').outcome).toBe('pass');
    });

    it('the types param widens it to stories', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(withCheck({ id: 'has-children', params: { types: 'EPIC,STORY' } })), { projectRoot: dir, verifyCommand: 'exit 0' });
      const id = await card(pid, 'WORK', {}, 'STORY');
      expect((await validate(id)).status).toBe(422);
    });
  });

  describe('only-test-files-changed', () => {
    /** A card that entered WORK through verify, so its entry HEAD is recorded. */
    const entered = async (extra: Record<string, unknown> = {}) => {
      const dir = makeRepo();
      const pid = await project(await flow(withCheck({ id: 'only-test-files-changed' })), { projectRoot: dir, verifyCommand: 'exit 0', ...extra });
      const id = await card(pid, 'PLAN');
      expect((await validate(id)).status).toBe(200);
      expect((await item(id)).status).toBe('WORK');
      return { dir, id };
    };

    it('passes when only test files changed, including new untracked ones', async () => {
      const { dir, id } = await entered();
      fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'edited');
      fs.writeFileSync(path.join(dir, 'tests/b.test.js'), 'new');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(byId((await item(id)).lastChecks.results, 'only-test-files-changed').outcome).toBe('pass');
    });

    it('fails naming the non-test file that changed', async () => {
      const { dir, id } = await entered();
      fs.writeFileSync(path.join(dir, 'tests/b.test.js'), 'new');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/impl.js'), 'code');
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'only-test-files-changed').detail).toMatch(/src\/impl\.js/);
    });

    it('sees committed changes too: the diff is from the step\'s entry commit', async () => {
      const { dir, id } = await entered();
      fs.writeFileSync(path.join(dir, 'impl.js'), 'code');
      execSync('git add . && git commit -qm impl', { cwd: dir, shell: '/bin/sh' });
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'only-test-files-changed').detail).toMatch(/impl\.js/);
    });

    it('fails when nothing changed at all', async () => {
      const { id } = await entered();
      const res = await validate(id);
      expect(res.status).toBe(422);
      expect(byId(res.body.checks, 'only-test-files-changed').detail).toMatch(/nothing/i);
    });

    it('counts files under the test report surface as test files (fixtures, helpers)', async () => {
      const { dir, id } = await entered({ testReport: { format: 'junit-xml', command: 'true', reportPath: 'report.xml', surface: ['fixtures'] } });
      fs.mkdirSync(path.join(dir, 'fixtures'));
      fs.writeFileSync(path.join(dir, 'fixtures/data.json'), '{}');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('a card with no entry record warns and advances', async () => {
      const dir = makeRepo();
      const pid = await project(await flow(withCheck({ id: 'only-test-files-changed' })), { projectRoot: dir, verifyCommand: 'exit 0' });
      const id = await card(pid, 'WORK');
      const res = await validate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const r = byId((await item(id)).lastChecks.results, 'only-test-files-changed');
      expect(r).toMatchObject({ outcome: 'unavailable', blocking: false });
    });
  });
});
