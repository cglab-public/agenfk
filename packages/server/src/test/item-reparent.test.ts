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
 * The cycle case is not cosmetic: syncParentStatus() walks upward via
 * parent.parentId with no visited-set, so once a cycle exists any status
 * propagation that reaches it can recurse unboundedly. These tests pin the
 * guards and the happy path the CLI needs.
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
});
