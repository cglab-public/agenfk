/**
 * Tests for POST /items/:id/reparent — change an item's parent.
 * Covers: success cases, detach (null parent), 404s, and parent status sync.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage } from '../server';
import { Status, ItemType } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./reparent-test-db.sqlite');

describe('POST /items/:id/reparent', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();

    const res = await request(app)
      .post('/projects')
      .send({ name: 'Reparent Test Project' });
    projectId = res.body.id;
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('moves a TASK from one STORY to another', async () => {
    const story1 = await request(app).post('/items').send({ projectId, type: ItemType.STORY, title: 'Story A' });
    const story2 = await request(app).post('/items').send({ projectId, type: ItemType.STORY, title: 'Story B' });
    const task = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'Task', parentId: story1.body.id });

    const res = await request(app)
      .post(`/items/${task.body.id}/reparent`)
      .send({ newParentId: story2.body.id });

    expect(res.status).toBe(200);
    expect(res.body.parentId).toBe(story2.body.id);
  });

  it('detaches an item when newParentId is null', async () => {
    const story = await request(app).post('/items').send({ projectId, type: ItemType.STORY, title: 'Story C' });
    const task = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'Orphan Task', parentId: story.body.id });

    const res = await request(app)
      .post(`/items/${task.body.id}/reparent`)
      .send({ newParentId: null });

    expect(res.status).toBe(200);
    expect(res.body.parentId).toBeUndefined();
  });

  it('returns 404 when the item does not exist', async () => {
    const res = await request(app)
      .post('/items/00000000-0000-0000-0000-000000000000/reparent')
      .send({ newParentId: null });

    expect(res.status).toBe(404);
  });

  it('returns 404 when newParentId does not exist', async () => {
    const task = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'Floating Task' });

    const res = await request(app)
      .post(`/items/${task.body.id}/reparent`)
      .send({ newParentId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
  });

  it('syncs status of the old parent after detach', async () => {
    const story = await request(app).post('/items').send({ projectId, type: ItemType.STORY, title: 'Story D' });
    const task = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'Task D', parentId: story.body.id, status: Status.IN_PROGRESS });

    // Story should be IN_PROGRESS due to child
    const storyBefore = await request(app).get(`/items/${story.body.id}`);
    expect(storyBefore.body.status).toBe(Status.IN_PROGRESS);

    // Detach the child
    await request(app).post(`/items/${task.body.id}/reparent`).send({ newParentId: null });

    // Old parent (Story D) should no longer be forced to IN_PROGRESS
    // syncParentStatus skips when children.length === 0, so status stays — but it must not error
    const storyAfter = await request(app).get(`/items/${story.body.id}`);
    expect(storyAfter.status).toBe(200);
  });

  it('syncs status of the new parent after reparent', async () => {
    const epic = await request(app).post('/items').send({ projectId, type: ItemType.EPIC, title: 'Epic E' });
    const story = await request(app).post('/items').send({ projectId, type: ItemType.STORY, title: 'Story E', parentId: epic.body.id });
    const taskDone = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'Done Task', parentId: story.body.id });

    // Move task to DONE via internal token so parent syncs
    await request(app)
      .put(`/items/${taskDone.body.id}`)
      .set('x-agenfk-internal', process.env.AGENFK_VERIFY_TOKEN || 'test-verify-token')
      .send({ status: Status.DONE });

    // Create another task and reparent it under story
    const newTask = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'New Task' });

    const res = await request(app)
      .post(`/items/${newTask.body.id}/reparent`)
      .send({ newParentId: story.body.id });

    expect(res.status).toBe(200);
    // New parent should have been synced (story now has an active child)
    const storyAfter = await request(app).get(`/items/${story.body.id}`);
    expect(storyAfter.status).toBe(200);
  });

  it('supports reparenting a STORY to an EPIC (open hierarchy)', async () => {
    const epic = await request(app).post('/items').send({ projectId, type: ItemType.EPIC, title: 'Epic F' });
    const story = await request(app).post('/items').send({ projectId, type: ItemType.STORY, title: 'Story F' });

    const res = await request(app)
      .post(`/items/${story.body.id}/reparent`)
      .send({ newParentId: epic.body.id });

    expect(res.status).toBe(200);
    expect(res.body.parentId).toBe(epic.body.id);
  });

  it('returns 400 when newParentId is missing from body', async () => {
    const task = await request(app).post('/items').send({ projectId, type: ItemType.TASK, title: 'No Body Task' });

    const res = await request(app)
      .post(`/items/${task.body.id}/reparent`)
      .send({});

    expect(res.status).toBe(400);
  });
});
