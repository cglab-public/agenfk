/**
 * CGLAB-86 — type change on items with children.
 *
 * `PUT /items/:id` previously blocked ANY type change on an item that has
 * children ("Cannot change type of item with children"), which surfaced to
 * users as "there is no way to change an item type" — the UI, CLI and MCP
 * all expose the type field, the server just refused it whenever the item
 * had sub-items.
 *
 * The rule (user-specified): when the item has sub-items, the ONLY allowed
 * type change is EPIC -> STORY. Rationale: an EPIC's children are stories;
 * demoting the parent to a STORY keeps the tree coherent, while every other
 * transition (STORY -> EPIC, EPIC -> TASK, STORY -> TASK, ...) would break
 * the EPIC -> STORY -> TASK hierarchy the board relies on.
 *
 * These tests pin the rule and are expected to fail until the server
 * validation is updated (the EPIC -> STORY case currently 400s).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./item-type-change-test-db.sqlite');

describe('item type change (CGLAB-86)', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
    const r = await request(app).post('/projects').send({ name: 'type-change-test' });
    expect(r.status).toBe(201);
    projectId = r.body.id;
  });

  const makeItem = async (type: string, title: string, opts: { parentId?: string } = {}) => {
    const r = await request(app).post('/items').send({
      type,
      title,
      projectId,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    });
    expect(r.status).toBe(201);
    return r.body;
  };

  const putType = async (id: string, type: string) =>
    request(app).put(`/items/${id}`).send({ type });

  it('allows EPIC -> STORY when the epic has children (the reported bug)', async () => {
    const epic = await makeItem('EPIC', 'Parent epic');
    const child = await makeItem('STORY', 'Child story', { parentId: epic.id });

    const res = await putType(epic.id, 'STORY');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('STORY');

    // The child must survive the retype intact and still attached.
    const after = await request(app).get(`/items/${child.id}`);
    expect(after.status).toBe(200);
    expect(after.body.parentId).toBe(epic.id);
    expect(after.body.type).toBe('STORY');
  });

  it('still blocks every other type change on an item with children', async () => {
    // STORY with a task child -> EPIC
    const story = await makeItem('STORY', 'Story with task');
    await makeItem('TASK', 'Task child', { parentId: story.id });
    const r1 = await putType(story.id, 'EPIC');
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/EPIC.*STORY|children/i);

    // EPIC with children -> TASK
    const epic = await makeItem('EPIC', 'Epic');
    await makeItem('STORY', 'Story child', { parentId: epic.id });
    const r2 = await putType(epic.id, 'TASK');
    expect(r2.status).toBe(400);
    expect(r2.body.error).toMatch(/children/i);

    // STORY with children -> TASK
    const story2 = await makeItem('STORY', 'Story 2');
    await makeItem('TASK', 'Task child 2', { parentId: story2.id });
    const r3 = await putType(story2.id, 'TASK');
    expect(r3.status).toBe(400);
    expect(r3.body.error).toMatch(/children/i);
  });

  it('states the allowed transition in the error so users and agents can act on it', async () => {
    const epic = await makeItem('EPIC', 'Epic');
    await makeItem('STORY', 'Story child', { parentId: epic.id });
    const res = await putType(epic.id, 'BUG');
    expect(res.status).toBe(400);
    // The error must name the one allowed transition (EPIC -> STORY) rather
    // than a bare "remove children first" that leaves the user stuck.
    expect(res.body.error).toMatch(/EPIC/);
    expect(res.body.error).toMatch(/STORY/);
  });

  it('allows any type change on items without children (existing behaviour)', async () => {
    const task = await makeItem('TASK', 'Lonely task');
    const res = await putType(task.id, 'BUG');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('BUG');

    const bug = await makeItem('BUG', 'Lonely bug');
    const res2 = await putType(bug.id, 'EPIC');
    expect(res2.status).toBe(200);
    expect(res2.body.type).toBe('EPIC');
  });

  it('allows EPIC -> STORY without children (same rule, no children needed)', async () => {
    const epic = await makeItem('EPIC', 'Epic no kids');
    const res = await putType(epic.id, 'STORY');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('STORY');
  });

  it('setting the same type on an item with children is a no-op, not an error', async () => {
    const epic = await makeItem('EPIC', 'Epic same type');
    await makeItem('STORY', 'Story child', { parentId: epic.id });
    const res = await putType(epic.id, 'EPIC');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('EPIC');
  });

  it('still rejects invalid type values', async () => {
    const task = await makeItem('TASK', 'Task');
    const res = await request(app).put(`/items/${task.id}`).send({ type: 'MEGA' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid type/i);
  });
});
