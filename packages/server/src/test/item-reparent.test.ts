/**
 * Re-parenting an existing item, and the validation that was missing.
 *
 * `PUT /items/:id` has always destructured `parentId` and applied it straight to
 * storage with no checks whatsoever. That makes three bad states reachable by any
 * REST or MCP caller today:
 *   - a parent id that does not exist, orphaning the item behind a dangling link;
 *   - a parent in a different project, so the item shows under a tree it is not
 *     part of;
 *   - a cycle (self-parenting, or parenting to one's own descendant).
 *
 * The cycle case is about tree integrity rather than a crash: syncParentStatus()
 * recurses upward with no visited-set, but the recursion is gated on the derived
 * status actually changing and that derivation is monotonic toward DONE, so a
 * cycle converges after a hop or two instead of spinning. A cycle still corrupts
 * every consumer that walks the tree, which is reason enough to refuse it.
 * These tests pin the guards and the happy path the CLI needs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./item-reparent-test-db.sqlite');

describe('item re-parenting', () => {
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  const makeProject = async (name: string) => {
    const r = await request(app).post('/projects').send({ name });
    expect(r.status).toBe(201);
    return r.body.id;
  };

  const makeItem = async (type: string, title: string, opts: { projectId?: string; parentId?: string } = {}) => {
    const r = await request(app).post('/items').send({
      type,
      title,
      projectId: opts.projectId ?? projectId,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    });
    expect(r.status).toBe(201);
    return r.body;
  };

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    projectId = await makeProject('reparent-proj');
    otherProjectId = await makeProject('other-proj');
  });

  // ── Happy path ────────────────────────────────────────────────────────────
  it('attaches a previously top-level item to a parent', async () => {
    const story = await makeItem('STORY', 'Parent story');
    const bug = await makeItem('BUG', 'Loose bug');
    expect(bug.parentId ?? null).toBeNull();

    const r = await request(app).put(`/items/${bug.id}`).send({ parentId: story.id });
    expect(r.status).toBe(200);
    expect(r.body.parentId).toBe(story.id);

    const children = await request(app).get(`/items?parentId=${story.id}`);
    expect(children.body.map((c: any) => c.id)).toContain(bug.id);
  });

  it('moves an item from one parent to another', async () => {
    const a = await makeItem('STORY', 'Story A');
    const b = await makeItem('STORY', 'Story B');
    const task = await makeItem('TASK', 'Task', { parentId: a.id });

    const r = await request(app).put(`/items/${task.id}`).send({ parentId: b.id });
    expect(r.status).toBe(200);
    expect(r.body.parentId).toBe(b.id);

    const oldChildren = await request(app).get(`/items?parentId=${a.id}`);
    expect(oldChildren.body.map((c: any) => c.id)).not.toContain(task.id);
  });

  it('detaches an item to top level when parentId is null', async () => {
    const story = await makeItem('STORY', 'Story');
    const task = await makeItem('TASK', 'Task', { parentId: story.id });

    const r = await request(app).put(`/items/${task.id}`).send({ parentId: null });
    expect(r.status).toBe(200);
    expect(r.body.parentId ?? null).toBeNull();
  });

  it('leaves the parent alone when parentId is omitted', async () => {
    const story = await makeItem('STORY', 'Story');
    const task = await makeItem('TASK', 'Task', { parentId: story.id });

    const r = await request(app).put(`/items/${task.id}`).send({ title: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Renamed');
    expect(r.body.parentId).toBe(story.id);
  });

  // ── Validation ────────────────────────────────────────────────────────────
  it('rejects a parent id that does not exist', async () => {
    const task = await makeItem('TASK', 'Task');

    const r = await request(app).put(`/items/${task.id}`).send({ parentId: 'no-such-item' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/parent/i);

    const after = await request(app).get(`/items/${task.id}`);
    expect(after.body.parentId ?? null).toBeNull();
  });

  it('rejects a parent in a different project', async () => {
    const foreign = await makeItem('STORY', 'Foreign story', { projectId: otherProjectId });
    const task = await makeItem('TASK', 'Task');

    const r = await request(app).put(`/items/${task.id}`).send({ parentId: foreign.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/project/i);
  });

  it('rejects self-parenting', async () => {
    const task = await makeItem('TASK', 'Task');

    const r = await request(app).put(`/items/${task.id}`).send({ parentId: task.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/own parent/i);
  });

  // The one that would otherwise recurse until the process dies.
  it('rejects parenting to a direct child (a 2-cycle)', async () => {
    const epic = await makeItem('EPIC', 'Epic');
    const story = await makeItem('STORY', 'Story', { parentId: epic.id });

    const r = await request(app).put(`/items/${epic.id}`).send({ parentId: story.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/descendant|cycle/i);
  });

  it('rejects parenting to a deeper descendant', async () => {
    const epic = await makeItem('EPIC', 'Epic');
    const story = await makeItem('STORY', 'Story', { parentId: epic.id });
    const task = await makeItem('TASK', 'Task', { parentId: story.id });

    const r = await request(app).put(`/items/${epic.id}`).send({ parentId: task.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/descendant|cycle/i);

    const after = await request(app).get(`/items/${epic.id}`);
    expect(after.body.parentId ?? null).toBeNull();
  });

  it('still allows a sibling subtree to be re-parented under another branch', async () => {
    const epic = await makeItem('EPIC', 'Epic');
    const storyA = await makeItem('STORY', 'Story A', { parentId: epic.id });
    const storyB = await makeItem('STORY', 'Story B', { parentId: epic.id });
    const task = await makeItem('TASK', 'Task', { parentId: storyA.id });

    // storyB is not a descendant of task, so this is legal.
    const r = await request(app).put(`/items/${task.id}`).send({ parentId: storyB.id });
    expect(r.status).toBe(200);
    expect(r.body.parentId).toBe(storyB.id);
  });

  // ── Status roll-up on both sides ──────────────────────────────────────────
  // A re-parent changes the child set of the OLD parent too. Only syncing the
  // new one leaves the old parent asserting a status derived from a child it no
  // longer has.
  it("re-syncs the old parent's status after a child moves away", async () => {
    const oldParent = await makeItem('STORY', 'Old parent');
    const newParent = await makeItem('STORY', 'New parent');
    const ahead = await makeItem('TASK', 'Ahead', { parentId: oldParent.id });
    const laggard = await makeItem('TASK', 'Laggard', { parentId: oldParent.id });

    // Children at REVIEW + IN_PROGRESS roll the parent up to IN_PROGRESS.
    await request(app).put(`/items/${ahead.id}`).send({ status: 'IN_PROGRESS' });
    await request(app).put(`/items/${ahead.id}`).send({ status: 'REVIEW' });
    await request(app).put(`/items/${laggard.id}`).send({ status: 'IN_PROGRESS' });

    const before = await request(app).get(`/items/${oldParent.id}`);
    expect(before.body.status).toBe('IN_PROGRESS');

    // Move the laggard out. The old parent's only remaining child is at REVIEW,
    // so it should roll up to REVIEW — it will only do so if the OLD parent is
    // re-synced, which is the point.
    const moved = await request(app).put(`/items/${laggard.id}`).send({ parentId: newParent.id });
    expect(moved.status).toBe(200);

    const after = await request(app).get(`/items/${oldParent.id}`);
    expect(after.body.status).toBe('REVIEW');
  });

  it("re-syncs the old parent when a child is detached to top level", async () => {
    const oldParent = await makeItem('STORY', 'Old parent');
    const child = await makeItem('TASK', 'Child', { parentId: oldParent.id });

    await request(app).put(`/items/${child.id}`).send({ status: 'IN_PROGRESS' });
    const parentNow = await request(app).get(`/items/${oldParent.id}`);
    expect(parentNow.body.status).toBe('IN_PROGRESS');

    const r = await request(app).put(`/items/${child.id}`).send({ parentId: null });
    expect(r.status).toBe(200);

    // Old parent has no children left; syncParentStatus leaves a childless
    // parent alone, so this pins the CURRENT contract rather than inventing one.
    const after = await request(app).get(`/items/${oldParent.id}`);
    expect(after.body.status).toBe('IN_PROGRESS');
  });

  // ── Detach really clears storage, not just the response body ──────────────
  it('persists the detach — re-reading the item shows no parent', async () => {
    const story = await makeItem('STORY', 'Story');
    const task = await makeItem('TASK', 'Task', { parentId: story.id });

    await request(app).put(`/items/${task.id}`).send({ parentId: null });

    const reread = await request(app).get(`/items/${task.id}`);
    expect(reread.body.parentId ?? null).toBeNull();

    const children = await request(app).get(`/items?parentId=${story.id}`);
    expect(children.body.map((c: any) => c.id)).not.toContain(task.id);
  });

  it('persists an attach — re-reading shows the new parent', async () => {
    const story = await makeItem('STORY', 'Story');
    const task = await makeItem('TASK', 'Task');

    await request(app).put(`/items/${task.id}`).send({ parentId: story.id });

    const reread = await request(app).get(`/items/${task.id}`);
    expect(reread.body.parentId).toBe(story.id);
  });

  // ── The sibling write paths must not be a back door ───────────────────────
  // POST /items/bulk is an UPDATE route despite the verb, and POST /items sets
  // parentId at create time. Guarding only PUT would leave every rejected state
  // reachable one route over.
  describe('POST /items/bulk enforces the same parent rules', () => {
    it('refuses a cycle and reports it instead of applying it', async () => {
      const epic = await makeItem('EPIC', 'Epic');
      const story = await makeItem('STORY', 'Story', { parentId: epic.id });

      const r = await request(app).post('/items/bulk').send({
        items: [{ id: epic.id, updates: { parentId: story.id } }],
      });
      expect(r.status).toBe(200);
      expect(r.body.skipped?.[0]?.error).toMatch(/descendant|cycle/i);

      const after = await request(app).get(`/items/${epic.id}`);
      expect(after.body.parentId ?? null).toBeNull();
    });

    it('refuses a nonexistent parent', async () => {
      const task = await makeItem('TASK', 'Task');

      const r = await request(app).post('/items/bulk').send({
        items: [{ id: task.id, updates: { parentId: 'nope' } }],
      });
      expect(r.body.skipped?.[0]?.error).toMatch(/not found/i);

      const after = await request(app).get(`/items/${task.id}`);
      expect(after.body.parentId ?? null).toBeNull();
    });

    it('refuses a cross-project parent', async () => {
      const foreign = await makeItem('STORY', 'Foreign', { projectId: otherProjectId });
      const task = await makeItem('TASK', 'Task');

      const r = await request(app).post('/items/bulk').send({
        items: [{ id: task.id, updates: { parentId: foreign.id } }],
      });
      expect(r.body.skipped?.[0]?.error).toMatch(/project/i);
    });

    it('still applies a legitimate bulk re-parent, and re-syncs the old parent', async () => {
      const oldParent = await makeItem('STORY', 'Old');
      const newParent = await makeItem('STORY', 'New');
      const ahead = await makeItem('TASK', 'Ahead', { parentId: oldParent.id });
      const laggard = await makeItem('TASK', 'Laggard', { parentId: oldParent.id });

      await request(app).put(`/items/${ahead.id}`).send({ status: 'IN_PROGRESS' });
      await request(app).put(`/items/${ahead.id}`).send({ status: 'REVIEW' });
      await request(app).put(`/items/${laggard.id}`).send({ status: 'IN_PROGRESS' });

      const r = await request(app).post('/items/bulk').send({
        items: [{ id: laggard.id, updates: { parentId: newParent.id } }],
      });
      expect(r.status).toBe(200);
      expect(r.body.results[0].parentId).toBe(newParent.id);

      const after = await request(app).get(`/items/${oldParent.id}`);
      expect(after.body.status).toBe('REVIEW');
    });
  });

  describe('POST /items enforces parent existence and project', () => {
    it('refuses a nonexistent parent at create time', async () => {
      const r = await request(app).post('/items').send({
        type: 'TASK', title: 'Orphan', projectId, parentId: 'no-such-parent',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/not found/i);
    });

    it('refuses a cross-project parent at create time', async () => {
      const foreign = await makeItem('STORY', 'Foreign', { projectId: otherProjectId });

      const r = await request(app).post('/items').send({
        type: 'TASK', title: 'Misfiled', projectId, parentId: foreign.id,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/project/i);
    });

    it('still creates a child under a valid parent', async () => {
      const story = await makeItem('STORY', 'Story');
      const r = await request(app).post('/items').send({
        type: 'TASK', title: 'Child', projectId, parentId: story.id,
      });
      expect(r.status).toBe(201);
      expect(r.body.parentId).toBe(story.id);
    });
  });

  it('rejects a non-string parentId with 400 rather than a 500 from the driver', async () => {
    const task = await makeItem('TASK', 'Task');

    const r = await request(app).put(`/items/${task.id}`).send({ parentId: { nested: true } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/string/i);
  });
});
