/**
 * @vitest-environment node
 *
 * A session's worktree state, over REST.
 *
 * The card's own observation, and it is right: the CLI already has this
 * (`agenfk branch status`). What was missing is a way for the desktop to ask,
 * not the logic. So this route is thin on purpose — it resolves the worktree,
 * runs one git command and hands the parse to core.
 *
 * Every git call uses execFile with an ARGUMENT ARRAY, never a shell string.
 * Branch names and paths come from user data, and a single `exec` with an
 * interpolated branch is the difference between a status panel and a shell.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call. That
 * churn produced `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` — a
 * transport failure, not an assertion about anything under test. It hands the
 * test an empty body, so `res.body.id` is undefined and the next call goes to
 * `/items/undefined`; one bad socket then surfaces as `expected 404 to be 400`
 * in whichever test happened to be running. Different test every run, green
 * when run alone.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./item-git-status-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

describe('GET /items/:id/git-status', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    const p = await internal(agent().post('/projects')).send({ name: 'git-status' });
    projectId = p.body.id;
  });

  it('404s for an item that does not exist', async () => {
    expect((await agent().get('/items/no-such-item/git-status')).status).toBe(404);
  });

  it('says so when the item has no worktree, rather than guessing a directory', async () => {
    // Falling back to the server's cwd would report the state of whatever
    // repository the server happens to be running in — confidently, and about
    // the wrong tree.
    const item = await agent().post('/items')
      .send({ title: 'No worktree', type: 'TASK', projectId });
    const res = await agent().get(`/items/${item.body.id}/git-status`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/worktree/i);
  });

  it('reports the real state of a real worktree', async () => {
    // An actual repository, created through the real worktree endpoint, because
    // the value of this route is that it tells the truth about a directory on
    // disk — and the path it reads has to be the one the app actually made.
    const os = require('os');
    const { execFileSync } = require('child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gs-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: repo });

    const item = await agent().post('/items')
      .send({ title: 'Has a worktree', type: 'TASK', projectId });
    // projectRoot is deliberately not settable over PUT /projects/:id — it is
    // a cwd, and the route's own comment keeps it out of the allowlist for
    // that reason. The supported way in is a verify reporting where it ran,
    // which is also the path a real agent takes. `.agenfk` marks it as a
    // project root so the walk-up stops here instead of at $HOME.
    fs.mkdirSync(path.join(repo, '.agenfk'), { recursive: true });
    await internal(agent().post(`/items/${item.body.id}/validate`))
      .send({ cwd: repo, evidence: 'setting the project root for this test' });
    const made = await internal(agent().post(`/items/${item.body.id}/worktree`))
      .send({ repoRoot: repo, branchName: 'feat/status-probe' });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);

    const wt = made.body.path as string;
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'two\n');
    fs.writeFileSync(path.join(wt, 'brand new.txt'), 'x\n');

    const res = await agent().get(`/items/${item.body.id}/git-status`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed).toBeGreaterThanOrEqual(2);
    // The path with a space has to survive, which is the whole reason for -z.
    expect(res.body.files.map((f: { path: string }) => f.path)).toContain('brand new.txt');

    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('answers plainly when the directory is not a repository', async () => {
    // A worktree recorded and then deleted by hand. An empty status would be a
    // lie — "nothing changed" reads as a clean tree.
    const notARepo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agenfk-nogit-'));
    const item = await agent().post('/items')
      .send({ title: 'Gone', type: 'TASK', projectId });
    await internal(agent().put(`/items/${item.body.id}`)).send({ worktreePath: notARepo });
    const res = await agent().get(`/items/${item.body.id}/git-status`);
    expect(res.status).toBe(409);
    fs.rmSync(notARepo, { recursive: true, force: true });
  });
});
