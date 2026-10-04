/**
 * @file 19e660ac — a project in a subdirectory shares a green only with content
 * that is the same OUTSIDE its root too.
 *
 * Reuse (a capture's filesState / suiteState) and the final step's sibling
 * propagation (a test record's treeState) hashed the project root's files and
 * nothing else. In a monorepo the root is one package and its tests import its
 * neighbours: a green taken before another agent committed a change in
 * packages/lib was reused after it, and a sibling closed DONE on it without
 * running the verify command.
 *
 * What lies beside the root now counts by content - HEAD's tree there, overlaid
 * with the work in progress - so the same bytes still share (a close commit, or
 * another agent committing exactly what it had), and different bytes never do.
 */
import { testDbPath } from './helpers/testDb';
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

const TEST_DB = testDbPath('outside-root-reuse-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();
const counter = (file: string) => () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A monorepo: the project is packages/app; packages/lib sits beside it. */
function monorepo() {
  const repo = tmp('agenfk-or-repo-');
  fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'app', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'lib.js'), 'one\n');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
  return { repo, root: path.join(repo, 'packages', 'app'), lib: path.join(repo, 'packages', 'lib', 'lib.js') };
}

async function captureSetup() {
  const f = await agent().post('/flows').send({ name: `or-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const m = monorepo();
  const runs = path.join(tmp('agenfk-or-runs-'), 'runs');
  const runner = path.join(path.dirname(runs), 'runner.js');
  fs.writeFileSync(runner, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="adds numbers" file="t.test.js"/></testsuite></testsuites>');`);
  const p = await agent().post('/projects').send({ name: `or-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: m.root, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const card = async () => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `or-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    return c.body.id as string;
  };
  return { ...m, card, count: counter(runs) };
}
const capture = (id: string) => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});

describe('19e660ac: capture reuse in a subdirectory project', () => {
  it('a commit beside the root is other content: the next card runs its own', async () => {
    const t = await captureSetup();
    const a = await t.card();
    expect((await capture(a)).body).toMatchObject({ available: true, exitCode: 0 });
    fs.writeFileSync(t.lib, 'two\n');
    git(t.repo, 'git commit -qam lib-two');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });

  it('uncommitted work beside the root is other content too', async () => {
    const t = await captureSetup();
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    fs.writeFileSync(t.lib, 'mid-edit\n');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });

  it('work beside the root committed exactly as it was is the same content: the next card reuses', async () => {
    const t = await captureSetup();
    fs.writeFileSync(t.lib, 'two\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    git(t.repo, 'git commit -qam lib-two');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.body.reusedFrom, JSON.stringify(rb.body)).toMatchObject({ itemId: a });
    expect(t.count()).toBe(1);
  });

  it("a close committing the root's own files unchanged still reuses", async () => {
    const t = await captureSetup();
    fs.writeFileSync(path.join(t.root, 'b.js'), 'b\n');
    const a = await t.card();
    expect((await capture(a)).status).toBe(200);
    git(t.repo, 'git add packages/app/b.js && git commit -qm a-closes');
    const b = await t.card();
    const rb = await capture(b);
    expect(rb.body.reusedFrom, JSON.stringify(rb.body)).toMatchObject({ itemId: a });
    expect(t.count()).toBe(1);
  });
});

/** A STORY with TASK children on the step before DONE, in a subdirectory project. */
async function verifySetup() {
  const m = monorepo();
  const runs = path.join(tmp('agenfk-or-prop-runs-'), 'runs');
  const verifyCommand = `node -e "require('fs').appendFileSync(${JSON.stringify(runs).replace(/"/g, '\\"')}, 'run\\n')"`;
  const p = (await agent().post('/projects').set(internal()).send({ name: `or-prop-${++seq}` })).body;
  await storage.updateProject(p.id, { projectRoot: m.root, verifyCommand } as never);
  const parent = (await agent().post('/items').set(internal()).send({ type: 'STORY', title: 'p', projectId: p.id })).body;
  const child = async () => {
    const c = (await agent().post('/items').set(internal()).send({ type: 'TASK', title: `c-${++seq}`, projectId: p.id, parentId: parent.id })).body;
    await storage.updateItem(c.id, { status: 'TEST' } as any);
    return c.id as string;
  };
  return { ...m, child, count: counter(runs) };
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });

describe('19e660ac: final-step sibling propagation in a subdirectory project', () => {
  it('another agent committed beside the root after the sibling verified: the next card runs the command', async () => {
    const t = await verifySetup();
    const a = await t.child();
    expect((await validate(a)).body.status).toBe('DONE');
    expect(t.count()).toBe(1);
    fs.writeFileSync(t.lib, 'two\n');
    git(t.repo, 'git commit -qam lib-two');
    const b = await t.child();
    const rb = await validate(b);
    expect(rb.body.status, JSON.stringify(rb.body)).toBe('DONE');
    expect(rb.body.output).not.toBe('Sibling propagation');
    expect(t.count()).toBe(2);
  });

  it('nothing changed beside the root: the sibling still propagates', async () => {
    const t = await verifySetup();
    const a = await t.child();
    expect((await validate(a)).body.status).toBe('DONE');
    const b = await t.child();
    const rb = await validate(b);
    expect(rb.body.output, JSON.stringify(rb.body)).toBe('Sibling propagation');
    expect(t.count()).toBe(1);
  });
});
