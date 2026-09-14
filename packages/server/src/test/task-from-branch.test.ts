/**
 * @vitest-environment node
 *
 * Starting a task from a branch, in one action (CGLAB-179).
 *
 * The card's own reading, and it is right: almost all of this exists and is
 * simply not joined up. Creating the item, naming the branch, cutting the
 * worktree and recording which agent to use are four things a person currently
 * does in four steps, and three of them are bookkeeping.
 *
 * So this route is a composition, not new machinery. What it has to get right
 * is what compositions usually get wrong: what happens when step three fails
 * after steps one and two already succeeded.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./task-from-branch-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

let repo: string;
let projectId: string;

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-tfb-'));
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

describe('POST /projects/:id/tasks-from-branch', () => {
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
    const p = await internal(request(app).post('/projects')).send({ name: 'from-branch' });
    projectId = p.body.id;
    const seed = await request(app).post('/items')
      .send({ title: 'seed', type: 'TASK', projectId });
    await internal(request(app).post(`/items/${seed.body.id}/validate`))
      .send({ cwd: repo, evidence: 'set the project root' });
  });

  it('creates the item, the branch and the worktree in one call', async () => {
    const res = await internal(request(app).post(`/projects/${projectId}/tasks-from-branch`))
      .send({ title: 'Fix the login redirect', branchName: 'fix/login-redirect', agentId: 'claude-code' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item.branchName).toBe('fix/login-redirect');
    expect(res.body.item.worktreePath).toBeTruthy();
    expect(fs.existsSync(res.body.item.worktreePath)).toBe(true);
  });

  it('records the agent on the item, so the terminal opens with it', async () => {
    // The card asks for the agent to be chosen up front. Recording it here is
    // what makes that choice mean something later.
    const res = await internal(request(app).post(`/projects/${projectId}/tasks-from-branch`))
      .send({ title: 'With pi', branchName: 'feat/with-pi', agentId: 'pi' });
    expect(res.body.item.agentId).toBe('pi');
  });

  it('derives a branch name when none is given', async () => {
    const res = await internal(request(app).post(`/projects/${projectId}/tasks-from-branch`))
      .send({ title: 'Some new thing', agentId: 'claude-code' });
    expect(res.body.item.branchName).toMatch(/some-new-thing/);
  });

  it('refuses an agent outside the launchable set', async () => {
    // The set is a security boundary; recording something outside it would
    // either fail at spawn or become a way to influence what runs.
    const res = await internal(request(app).post(`/projects/${projectId}/tasks-from-branch`))
      .send({ title: 'Bad agent', agentId: 'rm -rf /' });
    expect(res.status).toBe(400);
  });

  it('requires a title', async () => {
    const res = await internal(request(app).post(`/projects/${projectId}/tasks-from-branch`))
      .send({ agentId: 'claude-code' });
    expect(res.status).toBe(400);
  });

  it('does not leave a half-made task behind when the worktree cannot be cut', async () => {
    // The failure a composition usually gets wrong. A card with a branch name
    // and no worktree looks finished and is not, and the user has no way to
    // tell which of the four steps did not happen.
    const other = await internal(request(app).post('/projects')).send({ name: 'no-root' });
    const res = await internal(request(app).post(`/projects/${other.body.id}/tasks-from-branch`))
      .send({ title: 'Cannot work', branchName: 'feat/nope', agentId: 'claude-code' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const items = await request(app).get(`/items?projectId=${other.body.id}`);
    expect(items.body.filter((i: { title: string }) => i.title === 'Cannot work')).toHaveLength(0);
  });
});
