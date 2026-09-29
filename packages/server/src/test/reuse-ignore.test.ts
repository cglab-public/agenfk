/**
 * @file 32045202 — capture reuse ignores what no test reads.
 *
 * A docs edit changed the tree's content, so the next step ran the whole
 * suite again (CGLAB-428: a Markdown edit re-ran 7137 tests). A capture now
 * also records `suiteState`: the tree with the project's reuse-ignore globs
 * left out (default: every Markdown file) - except a file some test names,
 * which still counts (this repo's release test reads CHANGELOG.md). Only
 * capture reuse matches on it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./reuse-ignore-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
// Loaded in a hook with the error swallowed: the module is new, and a failing hook would skip the tests.
const ignoreModule = () => import('../reuseIgnore');

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('reuseIgnoreMatcher', () => {
  let reuseIgnoreMatcher: (patterns: readonly string[]) => (rel: string) => boolean;
  beforeAll(async () => { try { ({ reuseIgnoreMatcher } = await ignoreModule()); } catch { /* not there yet */ } });

  it('**/*.md matches Markdown at any depth, and nothing else', () => {
    const m = reuseIgnoreMatcher(['**/*.md']);
    for (const p of ['README.md', 'docs/guide.md', 'a/b/c/NOTES.md']) expect(m(p), p).toBe(true);
    for (const p of ['README.mdx', 'md/index.ts', 'src/md.ts', 'README.md.bak']) expect(m(p), p).toBe(false);
  });

  it('a directory glob covers everything under it; * stays within one segment', () => {
    const docs = reuseIgnoreMatcher(['docs/**']);
    expect(docs('docs/a/b.txt')).toBe(true);
    expect(docs('src/docs/a.txt')).toBe(false);
    const top = reuseIgnoreMatcher(['*.txt']);
    expect(top('notes.txt')).toBe(true);
    expect(top('a/notes.txt')).toBe(false);
  });

  it('an empty list ignores nothing', () => {
    expect(reuseIgnoreMatcher([])('README.md')).toBe(false);
  });
});

describe('namedByTests', () => {
  let namedByTests: (candidates: readonly string[], testSources: readonly string[]) => Set<string>;
  beforeAll(async () => { try { ({ namedByTests } = await ignoreModule()); } catch { /* not there yet */ } });

  it('keeps a candidate whose file name appears in some test source', () => {
    const named = namedByTests(['CHANGELOG.md', 'docs/guide.md', 'README.md'], ["expect(read('CHANGELOG.md')).toMatch(/2.0/)", "const g = 'docs/guide.md'"]);
    expect([...named].sort()).toEqual(['CHANGELOG.md', 'docs/guide.md']);
  });

  it('names nothing when no test mentions a candidate', () => {
    expect(namedByTests(['README.md'], ['expect(1).toBe(1)']).size).toBe(0);
  });

  // 6dd15e6e (review of 6caae168, finding 4): a test that reads a DIRECTORY of Markdown files names none of them.
  it('names a file whose directory a test builds from quoted parts', () => {
    const named = namedByTests(['.claude/commands/agenfk-release-foo.md'], ["const dir = path.join(REPO_ROOT, '.claude', 'commands'); readdirSync(dir)"]);
    expect([...named]).toEqual(['.claude/commands/agenfk-release-foo.md']);
  });

  it('names a file whose directory path a test spells out', () => {
    expect([...namedByTests(['skills/pdf/SKILL-notes.md'], ['for (const d of readdirSync("repo/skills/pdf")) {}'])]).toEqual(['skills/pdf/SKILL-notes.md']);
  });

  it('a directory\'s name as a bare word in prose names nothing', () => {
    expect(namedByTests(['docs/guide.md'], ['// see the docs for the details']).size).toBe(0);
  });
});

let seq = 0;
const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
/** A repo with a test file that names CHANGELOG.md, a README, docs and code; its runs counted outside the tree. */
async function setup(reuseIgnore?: string[]) {
  const s = (name: string, order: number) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...(order === 0 || name === 'END' ? { isAnchor: true } : {}) });
  const f = await agent().post('/flows').send({ name: `ri-${++seq}`, steps: [s('START', 0), s('WORK', 1), s('END', 2)] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ri-repo-')));
  dirs.push(repo);
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## 1.0\n');
  fs.writeFileSync(path.join(repo, 'docs', 'guide.txt'), 'guide\n');
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'release.test.js'), "test('changelog', () => require('fs').readFileSync('CHANGELOG.md'));\n");
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ri-ctl-')));
  dirs.push(outside);
  const runs = path.join(outside, 'runs');
  const runner = path.join(outside, 'runner.js');
  fs.writeFileSync(runner, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="changelog" file="release.test.js"/></testsuite></testsuites>');`);
  const p = await agent().post('/projects').send({ name: `ri-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml', ...(reuseIgnore ? { reuseIgnore } : {}) } } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `ri-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  const count = () => fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length;
  const capture = () => agent().post(`/items/${c.body.id}/step-records/capture`).set(internal()).send({});
  const edit = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  return { projectId: p.body.id as string, count, capture, edit };
}

describe('capture reuse at the same content, docs aside', () => {
  it('a Markdown edit no test names reuses the green: the suite does not run again', async () => {
    const t = await setup();
    expect((await t.capture()).status).toBe(200);
    t.edit('README.md', '# app, reworded\n');
    const again = await t.capture();
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(t.count()).toBe(1);
    expect(again.body.reusedFrom).toBeTruthy();
  });

  it('a new Markdown file no test names reuses the green too', async () => {
    const t = await setup();
    expect((await t.capture()).status).toBe(200);
    t.edit('NOTES.md', 'scratch\n');
    await t.capture();
    expect(t.count()).toBe(1);
  });

  it('a Markdown file a test names still counts: editing it runs the suite', async () => {
    const t = await setup();
    expect((await t.capture()).status).toBe(200);
    t.edit('CHANGELOG.md', '## 1.0\n## 1.1\n');
    const again = await t.capture();
    expect(t.count()).toBe(2);
    expect(again.body.reusedFrom).toBeUndefined();
  });

  it('a code edit still runs the suite', async () => {
    const t = await setup();
    expect((await t.capture()).status).toBe(200);
    t.edit('a.js', 'module.exports = 2;\n');
    await t.capture();
    expect(t.count()).toBe(2);
  });

  it("the project's own globs replace the default", async () => {
    const t = await setup(['docs/**']);
    expect((await t.capture()).status).toBe(200);
    t.edit('docs/guide.txt', 'guide, v2\n');
    await t.capture();
    expect(t.count()).toBe(1);
    t.edit('README.md', '# now counted\n');
    await t.capture();
    expect(t.count()).toBe(2);
  });

  it('an empty list turns it off: a Markdown edit runs the suite', async () => {
    const t = await setup([]);
    expect((await t.capture()).status).toBe(200);
    t.edit('README.md', '# counted\n');
    await t.capture();
    expect(t.count()).toBe(2);
  });
});

describe('PUT /projects/:id/test-report with reuseIgnore', () => {
  const put = (id: string, body: Record<string, unknown>) => agent().put(`/projects/${id}/test-report`).set(internal()).send(body);
  const base = { format: 'junit-xml', command: 'node run.js', reportPath: 'report.xml' };

  it('stores a list of globs', async () => {
    const t = await setup();
    const r = await put(t.projectId, { ...base, reuseIgnore: ['docs/**', '**/*.md'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(((await storage.getProject(t.projectId)) as any).testReport.reuseIgnore).toEqual(['docs/**', '**/*.md']);
  });

  it('refuses anything but a list of non-empty strings', async () => {
    const t = await setup();
    expect((await put(t.projectId, { ...base, reuseIgnore: 'docs/**' })).status).toBe(400);
    expect((await put(t.projectId, { ...base, reuseIgnore: [''] })).status).toBe(400);
  });
});
