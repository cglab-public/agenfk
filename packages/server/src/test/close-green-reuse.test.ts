/**
 * @file e99b5015 — reuse after a close, and one capture per identical tree.
 *
 * (1) A card's last per-test capture ran on its DIRTY tree, just before its
 * close commit, so it was never a green of any commit and the first card after
 * every close paid a whole suite run for its entry baseline. When the close
 * leaves the tree clean and the files are exactly the ones the capture ran on,
 * that capture is re-stamped as a green of the close commit.
 *
 * (2) SINGLE-FLIGHT: captures of one clean tree, at one commit, with one
 * command, that start while an identical one runs, wait for it and take its
 * record. Seen live: three siblings' baselines ran three whole suites at once
 * in one worktree, and the shared on-disk sandbox gave two of them false
 * failures. A dirty tree is not shared: its content is that card's own.
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

const TEST_DB = path.resolve('./close-green-reuse-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN, stampCloseGreen } from '../server';

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
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: '/bin/sh', encoding: 'utf8' }).trim();

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/**
 * A project whose report command writes a junit report (git-ignored) and
 * counts its runs outside the tree; `sleepMs` keeps a run open long enough for
 * a second capture to start while it runs.
 */
async function setup(sleepMs = 0, exitCode = 0) {
  const f = await agent().post('/flows').send({ name: `cg-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = tmp('agenfk-cg-repo-');
  git(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && echo a > a && git add . && git commit -qm one');
  const runs = path.join(tmp('agenfk-cg-runs-'), 'runs');
  const runner = path.join(path.dirname(runs), 'runner.js');
  fs.writeFileSync(runner, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
setTimeout(() => {
  require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="adds numbers" file="t.test.js"/></testsuite></testsuites>');
  process.exit(${exitCode});
}, ${sleepMs});`);
  const p = await agent().post('/projects').send({ name: `cg-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: 'true', testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
  const card = async () => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `cg-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    return c.body.id as string;
  };
  const count = () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
  return { repo, pid: p.body.id as string, card, count };
}

const capture = (id: string) => agent().post(`/items/${id}/step-records/capture`).set(internal()).send({});
const commitAll = (repo: string, msg: string) => git(repo, `git add -A && git commit -qm ${msg} && git rev-parse HEAD`);

describe('e99b5015 (1): the close green becomes the next card\'s baseline', () => {
  it('a capture on the dirty tree, then a close that leaves it clean: the next card reuses it, no suite runs', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    const first = await capture(a);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ clean: false, available: true, exitCode: 0 });
    expect(t.count()).toBe(1);

    const sha = commitAll(t.repo, 'close');
    const stamped = await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'));
    expect(stamped).toMatchObject({ head: sha, clean: true, available: true, exitCode: 0 });
    expect(stamped.reusedFrom).toBeUndefined();

    const b = await t.card();
    const next = await capture(b);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(t.count()).toBe(1);
    expect(next.body).toMatchObject({ head: sha, clean: true, reusedFrom: { itemId: a } });
    expect(next.body.tests.map((x: any) => x.name)).toEqual(expect.arrayContaining([expect.stringContaining('adds numbers')]));
  });

  it('no stamp when the close left unstaged work behind: the tree is not what the commit holds', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    git(t.repo, 'git add feature.js && git commit -qm close');
    fs.writeFileSync(path.join(t.repo, 'leftover.js'), 'x\n');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('no stamp when a file the capture ran on was left out of the commit: same files on disk, not in the commit', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(t.repo, 'helper.js'), 'module.exports = 2;\n');
    expect((await capture(a)).status).toBe(200);
    git(t.repo, 'git add feature.js && git commit -qm close');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('no stamp when the commit holds other content than the capture ran on', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 2;\n');
    commitAll(t.repo, 'close');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('no stamp when another agent\'s work landed in the same commit: the green never covered it', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    fs.writeFileSync(path.join(t.repo, 'theirs.js'), 'other agent\n');
    commitAll(t.repo, 'theirs-and-close');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
    const b = await t.card();
    expect((await capture(b)).status).toBe(200);
    expect(t.count()).toBe(2);
  });

  it('no stamp from a capture that failed: only a green is reused', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    const card: any = await storage.getItem(a);
    await storage.updateItem(a, { stepRecords: card.stepRecords.map((r: any) => ({ ...r, exitCode: 1 })) } as any);
    commitAll(t.repo, 'close');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('the stamp enters the green index, so a project already indexed finds it', async () => {
    const t = await setup();
    const warm = await t.card();
    expect((await capture(warm)).status).toBe(200); // a clean capture: the project's greens are indexed now
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    const sha = commitAll(t.repo, 'close');
    expect(await stampCloseGreen(a, t.repo, sha)).not.toBeNull();
    const before = t.count();
    const b = await t.card();
    expect((await capture(b)).body.reusedFrom).toMatchObject({ itemId: a });
    expect(t.count()).toBe(before);
  });

  it('no stamp for a capture that was already a green of this commit', async () => {
    const t = await setup();
    const a = await t.card();
    expect((await capture(a)).body.clean).toBe(true);
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('no stamp when the last run on this content was red, even after an earlier green on it', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    const card: any = await storage.getItem(a);
    const green = card.stepRecords[card.stepRecords.length - 1];
    await storage.updateItem(a, { stepRecords: [...card.stepRecords, { ...green, at: new Date(Date.now() + 1000).toISOString(), exitCode: 1 }] } as any);
    commitAll(t.repo, 'close');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('no stamp when a file became executable after the run: the mode is content too', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'run.sh'), 'echo hi\n');
    expect((await capture(a)).status).toBe(200);
    fs.chmodSync(path.join(t.repo, 'run.sh'), 0o755);
    commitAll(t.repo, 'close');
    expect(await stampCloseGreen(a, t.repo, git(t.repo, 'git rev-parse HEAD'))).toBeNull();
  });

  it('no stamp when HEAD is not the commit the close stamped: another agent committed in between', async () => {
    const t = await setup();
    const a = await t.card();
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    expect((await capture(a)).status).toBe(200);
    const closed = commitAll(t.repo, 'close');
    git(t.repo, 'git commit -q --allow-empty -m theirs');
    expect(await stampCloseGreen(a, t.repo, closed)).toBeNull();
  });
});

describe('e99b5015 (2): identical captures are single-flight', () => {
  it('two cards capturing one clean tree at once run the suite once; the second takes the first\'s record', async () => {
    const t = await setup(800);
    const [a, b] = [await t.card(), await t.card()];
    const [ra, rb] = await Promise.all([capture(a), capture(b)]);
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(t.count()).toBe(1);
    const shared = [ra.body, rb.body].filter(r => r.reusedFrom);
    expect(shared).toHaveLength(1);
    const owner = shared[0] === ra.body ? b : a;
    expect(shared[0].reusedFrom.itemId).toBe(owner);
    expect(shared[0].tests).toEqual((shared[0] === ra.body ? rb.body : ra.body).tests);
  });

  // 3ffc9651: a dirty tree is shared when its CONTENT is the same - the uncommitted work is the tree's, seen alike by both.
  it('a dirty tree with the same content is shared: one run, the waiting card takes its record', async () => {
    const t = await setup(800);
    fs.writeFileSync(path.join(t.repo, 'feature.js'), 'module.exports = 1;\n');
    const [a, b] = [await t.card(), await t.card()];
    const [ra, rb] = await Promise.all([capture(a), capture(b)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(t.count()).toBe(1);
    expect([ra.body, rb.body].filter(r => r.reusedFrom)).toHaveLength(1);
    expect([ra.body, rb.body].every(r => r.clean === false)).toBe(true);
  });

  it('a red run is not shared: the waiting card runs its own, after the first finishes', async () => {
    const t = await setup(500, 1);
    const [a, b] = [await t.card(), await t.card()];
    const [ra, rb] = await Promise.all([capture(a), capture(b)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(t.count()).toBe(2);
    expect(ra.body.reusedFrom).toBeUndefined();
    expect(rb.body.reusedFrom).toBeUndefined();
  });

  it('when the first card moves during its run, the waiting card starts over and runs its own', async () => {
    const t = await setup(800);
    const [a, b] = [await t.card(), await t.card()];
    // .then() sends the request now: supertest waits until something awaits it.
    const pa = capture(a).then(r => r);
    await new Promise(r => setTimeout(r, 200));
    const pb = capture(b).then(r => r);
    await new Promise(r => setTimeout(r, 200));
    await storage.updateItem(a, { status: 'END' } as any);
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.status).toBe(409);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.reusedFrom).toBeUndefined();
    expect(t.count()).toBe(2);
  });

  it('a waiter whose tree changed during the wait starts over: its record says dirty, not the clean it saw before', async () => {
    const t = await setup(800);
    const [a, b] = [await t.card(), await t.card()];
    const pa = capture(a).then(r => r);
    await new Promise(r => setTimeout(r, 200));
    const pb = capture(b).then(r => r);
    await new Promise(r => setTimeout(r, 200));
    // The waiting card's agent edits while it waits (the first run sees the change too and records no results).
    fs.writeFileSync(path.join(t.repo, 'edit.js'), 'x\n');
    const [, rb] = await Promise.all([pa, pb]);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.clean).toBe(false);
    expect(rb.body.reusedFrom).toBeUndefined();
  });
});
