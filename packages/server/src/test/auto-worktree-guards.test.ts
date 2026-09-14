/**
 * @vitest-environment node
 *
 * Who gets an automatic worktree, and what happens when one cannot be made.
 *
 * Two findings from the adversarial review of CGLAB-166, and they pull in
 * opposite directions — one is about doing LESS, the other about saying more.
 *
 * The auto-create path ran for EPICs and for child items, while `agenfk branch
 * create` refuses children outright. An EPIC is a container: it has no code of
 * its own, so a checkout for it is a full copy of the repository that nobody
 * will ever type in. A child shares its parent's branch by design.
 *
 * And when creation failed it was swallowed with a console warning. The agent
 * got a 200, assumed it had a worktree, and edited the MAIN tree — which is
 * precisely the collision this feature exists to prevent. A failure nobody can
 * see is worse than no feature.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN, shouldAutoWorktree, noteWorktreeFailure } from '../server';

const TEST_DB = path.resolve('./auto-worktree-guards-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

describe('who gets an automatic worktree', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    const p = await internal(request(app).post('/projects')).send({ name: 'wt-guards' });
    projectId = p.body.id;
    // projectRoot deliberately left unset: these tests are about the GUARDS
    // that run before any git command, so no repository is needed.
    await internal(request(app).put(`/projects/${projectId}`)).send({ autoWorktree: true });
  });

  it('never makes one for an EPIC', async () => {
    // A container with no code of its own. A checkout for it is a full copy of
    // the repository that nobody will ever type in — and `agenfk branch
    // create` already refuses it, so the two paths disagreed.
    const epic = await request(app).post('/items')
      .send({ title: 'The epic', type: 'EPIC', projectId });
    expect(shouldAutoWorktree(epic.body)).toBe(false);
  });

  it('never makes one for a child item', async () => {
    // A child shares its parent's branch by design, which is the whole reason
    // `agenfk branch create` refuses children explicitly.
    const parent = await request(app).post('/items')
      .send({ title: 'Parent', type: 'STORY', projectId });
    const child = await request(app).post('/items')
      .send({ title: 'Child', type: 'TASK', projectId, parentId: parent.body.id });
    expect(shouldAutoWorktree(child.body)).toBe(false);
  });

  it('makes one for a top-level STORY, TASK or BUG', async () => {
    // The common case has to keep working, or the guard has eaten the feature.
    for (const type of ['STORY', 'TASK', 'BUG']) {
      const item = await request(app).post('/items')
        .send({ title: `A ${type}`, type, projectId });
      expect(shouldAutoWorktree(item.body), type).toBe(true);
    }
  });

  it('does not make a second one for an item that already has it', async () => {
    const item = await request(app).post('/items')
      .send({ title: 'Already has one', type: 'TASK', projectId });
    expect(shouldAutoWorktree({ ...item.body, worktreePath: '/somewhere' })).toBe(false);
  });
});

describe('when the worktree cannot be made', () => {
  let projectId: string;
  beforeEach(async () => {
    await initStorage();
    const p = await internal(request(app).post('/projects')).send({ name: 'wt-fail' });
    projectId = p.body.id;
    await internal(request(app).put(`/projects/${projectId}`)).send({ autoWorktree: true });
    // A root that is not a repository, so `git worktree add` cannot succeed.
    await internal(request(app).put(`/projects/${projectId}`)).send({ name: 'wt-fail' });
  });

  it('records the failure on the item instead of only the server log', async () => {
    // The agent gets a 200 either way. Without a mark on the item it assumes
    // it has a worktree and edits the main tree — the exact collision this
    // feature exists to prevent, and a console warning is somewhere the agent
    // never looks.
    const item = await request(app).post('/items')
      .send({ title: 'Will fail', type: 'TASK', projectId });
    await noteWorktreeFailure(item.body.id, new Error('not a git repository'));
    const after = await request(app).get(`/items/${item.body.id}`);
    const text = JSON.stringify(after.body.comments ?? []);
    expect(text).toMatch(/worktree/i);
    expect(text).toMatch(/not a git repository/);
  });
});
