/**
 * @vitest-environment node
 *
 * Every route into work gets a worktree, not just two of them.
 *
 * `ensureWorktreeForItem` ran on two of the five paths that move an item into
 * a working step. The consequence is not subtle: turning `autoWorktree` on in
 * a project whose items have already left TODO means those items may never get
 * one — the setting reads as enabled and does nothing, and the agent edits the
 * main checkout believing it has its own tree.
 *
 * These assert on the RULE rather than on the plumbing: after a transition
 * into a working step, a card that qualifies has a worktree. Which function
 * arranged that is an implementation detail; the guarantee is not.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 26 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = path.resolve('./worktree-transitions-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

let repo: string;
let projectId: string;

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wt-tr-'));
  const { execFileSync } = require('child_process');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'first'], { cwd: dir });
  return dir;
};

describe('a status change through PUT /items/:id', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    fs.rmSync(repo, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await initStorage();
    repo = makeRepo();
    const p = await internal(agent().post('/projects')).send({ name: 'wt-transitions' });
    projectId = p.body.id;
    const seed = await agent().post('/items').send({ title: 'seed', type: 'TASK', projectId });
    await internal(agent().post(`/items/${seed.body.id}/validate`))
      .send({ cwd: repo, evidence: 'set the project root' });
    await internal(agent().put(`/projects/${projectId}`)).send({ autoWorktree: true });
  });

  it('gives the item a worktree, like the validate path already did', async () => {
    // The path an agent takes when it parks an item in a working step
    // directly, and the path an import takes. It had no worktree hook at all.
    const item = await agent().post('/items')
      .send({ title: 'Moved by hand', type: 'TASK', projectId });
    await internal(agent().put(`/items/${item.body.id}`)).send({ status: 'IN_PROGRESS' });
    const after = await agent().get(`/items/${item.body.id}`);
    expect(after.body.worktreePath, 'no worktree after moving into a working step').toBeTruthy();
  });

  it('does not make one for a move back to TODO', async () => {
    // TODO is not work. Cutting a tree for it would put one on every card the
    // moment a project turns the setting on.
    const item = await agent().post('/items')
      .send({ title: 'Back to todo', type: 'TASK', projectId });
    await internal(agent().put(`/items/${item.body.id}`)).send({ status: 'TODO' });
    const after = await agent().get(`/items/${item.body.id}`);
    expect(after.body.worktreePath ?? null).toBeNull();
  });

  it('does not make a second one for an item that already has it', async () => {
    const item = await agent().post('/items')
      .send({ title: 'Twice', type: 'TASK', projectId });
    await internal(agent().put(`/items/${item.body.id}`)).send({ status: 'IN_PROGRESS' });
    const first = (await agent().get(`/items/${item.body.id}`)).body.worktreePath;
    await internal(agent().put(`/items/${item.body.id}`)).send({ status: 'REVIEW' });
    const second = (await agent().get(`/items/${item.body.id}`)).body.worktreePath;
    expect(second).toBe(first);
  });

  it('still refuses an EPIC and a child, on this path too', async () => {
    // The guard has to hold wherever the item enters work, or the rule is only
    // true on the paths somebody remembered.
    const epic = await agent().post('/items')
      .send({ title: 'An epic', type: 'EPIC', projectId });
    await internal(agent().put(`/items/${epic.body.id}`)).send({ status: 'IN_PROGRESS' });
    expect((await agent().get(`/items/${epic.body.id}`)).body.worktreePath ?? null).toBeNull();

    const parent = await agent().post('/items')
      .send({ title: 'Parent', type: 'STORY', projectId });
    const child = await agent().post('/items')
      .send({ title: 'Child', type: 'TASK', projectId, parentId: parent.body.id });
    await internal(agent().put(`/items/${child.body.id}`)).send({ status: 'IN_PROGRESS' });
    expect((await agent().get(`/items/${child.body.id}`)).body.worktreePath ?? null).toBeNull();
  });

  it('does nothing when the project has not asked for worktrees', async () => {
    const other = await internal(agent().post('/projects')).send({ name: 'no-auto' });
    const item = await agent().post('/items')
      .send({ title: 'No auto', type: 'TASK', projectId: other.body.id });
    await internal(agent().put(`/items/${item.body.id}`)).send({ status: 'IN_PROGRESS' });
    expect((await agent().get(`/items/${item.body.id}`)).body.worktreePath ?? null).toBeNull();
  });
});
