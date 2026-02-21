import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage } from '../server';
import { Status, ItemType } from '@agenfk/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DB = path.resolve('./server-test-db.json');

describe('Server API', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });

  describe('GET /projects', () => {
    it('should return empty list initially', async () => {
      const res = await request(app).get('/projects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /projects', () => {
    it('should create a new project', async () => {
      const res = await request(app)
        .post('/projects')
        .send({ name: 'Test Project', description: 'Test Desc' });
      
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Project');
      expect(res.body.id).toBeDefined();
    });
  });

  describe('PUT /projects/:id', () => {
    it('should update a project', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send({ name: 'P1' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/projects/${id}`)
        .send({ name: 'P1 Updated' });
      
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('P1 Updated');
    });

    it('should return 404 for non-existent project', async () => {
      const res = await request(app)
        .put('/projects/none')
        .send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /projects/:id', () => {
    it('should delete a project', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send({ name: 'To Delete' });
      const id = createRes.body.id;

      const res = await request(app).delete(`/projects/${id}`);
      expect(res.status).toBe(204);

      const getRes = await request(app).get(`/projects/${id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe('GET /items', () => {
    it('should return empty items list', async () => {
      const res = await request(app).get('/items');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('Items Lifecycle', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await request(app).post('/projects').send({ name: 'Item Test' });
      projectId = res.body.id;
    });

    it('should create an item', async () => {
      const res = await request(app)
        .post('/items')
        .send({
          projectId,
          type: ItemType.TASK,
          title: 'T1',
          description: 'D1'
        });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('T1');
    });

    it('should update an item status', async () => {
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'To Update', description: 'D' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/items/${id}`)
        .send({ status: Status.IN_PROGRESS });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Status.IN_PROGRESS);
    });

    it('should block direct transition to DONE', async () => {
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'No Cheat', description: 'D' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/items/${id}`)
        .send({ status: Status.DONE });
      
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('WORKFLOW VIOLATION');
    });

    it('should allow transition to DONE with internal token', async () => {
      // Find the token
      const token = fs.readFileSync(path.join(os.homedir(), '.agenfk', 'verify-token'), 'utf8').trim();
      
      const createRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Verify Me', description: 'D' });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/items/${id}`)
        .set('x-agenfk-internal', token)
        .send({ status: Status.DONE });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(Status.DONE);
    });

    it('should propagate status to parent', async () => {
      const storyRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.STORY, title: 'Parent Story', description: 'D' });
      const storyId = storyRes.body.id;

      const taskRes = await request(app)
        .post('/items')
        .send({ projectId, type: ItemType.TASK, title: 'Child Task', description: 'D', parentId: storyId });
      const taskId = taskRes.body.id;

      // Update child to IN_PROGRESS
      await request(app).put(`/items/${taskId}`).send({ status: Status.IN_PROGRESS });

      // Check parent
      const parentRes = await request(app).get(`/items/${storyId}`);
      expect(parentRes.body.status).toBe(Status.IN_PROGRESS);
    });
  });
});
