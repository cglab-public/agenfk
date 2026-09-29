/**
 * @file de5e5a03 — what a capture record says it ran on is what it ran on.
 *
 * Found reviewing 6caae168:
 *  - the file map and the reuse state were read from the tree AFTER the check
 *    that the run saw one stable tree: an edit in that gap was recorded as
 *    what the run saw, and indexed as a green it never earned (finding 2);
 *  - a record whose per-test results could not be read back (a missing blob)
 *    counted as green (finding 6);
 *  - a tree state recorded before `--relative` (a subdirectory project hashed
 *    its modified tracked files as their index blobs) still matched today's
 *    (finding 8).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

/**
 * Every git call the server makes passes here first. Armed with a marker the
 * runner writes as it exits, `gap` edits a file at the first git call AFTER the
 * tree was read for the fence (its untracked listing) - inside the gap.
 */
const gap = vi.hoisted(() => ({ marker: '', edit: null as null | (() => void), seenFence: false }));
vi.mock('child_process', async (orig) => {
  const real: any = await orig();
  const nodeFs = await import('fs');
  const execFileSync = (...a: any[]) => {
    const args: string[] = Array.isArray(a[1]) ? a[1] : [];
    if (gap.edit && gap.marker && nodeFs.existsSync(gap.marker)) {
      if (gap.seenFence) { const e = gap.edit; gap.edit = null; e(); }
      else if (args.includes('--others') && !args.includes('--cached')) gap.seenFence = true;
    }
    return real.execFileSync(...a);
  };
  return { ...real, execFileSync, default: { ...real, execFileSync } };
});

const TEST_DB = path.resolve('./capture-record-soundness-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { capturedGreen } from '../checkEngine';

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
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${++seq}`, name, label: name, order, ...extra });

/** A project whose runner writes a green junit report, counts its runs and drops `marker` as it exits - all outside the tree. */
async function setup() {
  const f = await agent().post('/flows').send({ name: `cr-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-cr-repo-');
  fs.writeFileSync(path.join(repo, 'lib.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'pass adds\n');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one');
  const tools = tmp('agenfk-cr-tools-');
  const runs = path.join(tools, 'runs');
  const marker = path.join(tools, 'ran');
  const runner = path.join(tools, 'runner.js');
  fs.writeFileSync(runner, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(runs)}, 'run\\n');
fs.writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="adds" file="a.test.js"/></testsuite></testsuites>');
fs.writeFileSync(${JSON.stringify(marker)}, '1');`);
  const p = await agent().post('/projects').send({ name: `cr-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const card = async () => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `cr-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    return c.body.id as string;
  };
  const count = () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
  return { repo, marker, card, count };
}
const capture = (id: string) => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});
const lastCapture = async (id: string) => ((((await storage.getItem(id)) as any)?.stepRecords ?? []) as any[]).filter(r => r.kind === 'capture').pop();

describe('de5e5a03 (2): a capture records the tree it fenced, not the tree a moment later', () => {
  it('an edit landing just after the fence is neither in the record\'s files nor reusable as its green', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 2;\n');   // dirty: no clean-commit reuse
    const ranOn = git(t.repo, 'git hash-object lib.js');
    Object.assign(gap, { marker: t.marker, seenFence: false, edit: () => fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 3;\n') });
    const first = await capture(a);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(gap.edit, 'the edit landed in the gap').toBeNull();
    const rec = await lastCapture(a);
    expect(rec).toMatchObject({ available: true, exitCode: 0 });
    expect(rec.fileShas['lib.js']).toContain(ranOn);
    // Another card on the tree as it is now: nothing ever ran on this content.
    const b = await t.card();
    expect((await capture(b)).status).toBe(200);
    expect(t.count()).toBe(2);
    expect((await lastCapture(b)).reusedFrom).toBeUndefined();
  });
});

describe('de5e5a03 (6): results that cannot be read back are never green', () => {
  it('a record whose per-test results went missing is not green', () => {
    expect(capturedGreen({ kind: 'capture', available: true, exitCode: 0, testsMissing: true })).toBe(false);
  });

  it('a card with such a record does not lend it to another card as a green', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 2;\n');
    expect((await capture(a)).status).toBe(200);
    const card: any = await storage.getItem(a);
    await storage.updateItem(a, { stepRecords: card.stepRecords.map((r: any) => { const { tests: _t, ...rest } = r; return { ...rest, testsMissing: true }; }) } as any);
    const b = await t.card();
    expect((await capture(b)).status).toBe(200);
    expect(t.count()).toBe(2);
  });
});

describe('de5e5a03 (8): a tree state from before this build never matches', () => {
  it('a green recorded by an older build is not reused on the same content', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'lib.js'), 'module.exports = 2;\n');
    expect((await capture(a)).status).toBe(200);
    // As an older build wrote it: the same fields, without the marker of how its states were hashed.
    const card: any = await storage.getItem(a);
    await storage.updateItem(a, { stepRecords: card.stepRecords.map((r: any) => { const { stateVersion: _v, ...rest } = r; return rest; }) } as any);
    const b = await t.card();
    expect((await capture(b)).status).toBe(200);
    expect(t.count()).toBe(2);
  });
});
