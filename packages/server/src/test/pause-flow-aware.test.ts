/**
 * Regression: the pause guard hardcoded `[IN_PROGRESS, REVIEW, TEST]`, so a card
 * sitting in a custom-flow working step (e.g. CREATE_UNIT_TESTS) could not be
 * paused ("Cannot pause item in CREATE_UNIT_TESTS status"). It must instead allow
 * pausing any item in an active (non-anchor, non-inactive) working step of its
 * project's active flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./pause-flow-aware-test-db.sqlite');

describe('POST /items/:id/pause is flow-aware', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  async function projectInTddFlow() {
    const project = (await request(app).post('/projects').send({ name: 'PauseTdd' })).body;
    const flow = (await request(app).post('/flows').send({
      name: 'TDD-pause',
      steps: [
        { id: 'a', name: 'TODO', order: 1, isAnchor: true },
        { id: 'b', name: 'DISCOVERY', order: 2, exitCriteria: 'x' },
        { id: 'c', name: 'CREATE_UNIT_TESTS', order: 3, exitCriteria: 'x' },
        { id: 'd', name: 'IN_PROGRESS', order: 4, exitCriteria: 'x' },
        { id: 'e', name: 'DONE', order: 5, isAnchor: true },
      ],
    })).body;
    await request(app).post(`/projects/${project.id}/flow`).send({ flowId: flow.id });
    return project;
  }

  it('ALLOWS pausing an item parked in a custom working step (CREATE_UNIT_TESTS)', async () => {
    const project = await projectInTddFlow();
    const item = (await request(app).post('/items').send({
      projectId: project.id, type: 'TASK', title: 'tdd task', status: 'CREATE_UNIT_TESTS',
    })).body;

    const res = await request(app).post(`/items/${item.id}/pause`).send({
      summary: 'pausing mid-tests',
      resumeInstructions: 'resume the red tests',
    });
    expect(res.status).toBe(200);
  });

  it('REJECTS pausing an item in an anchor step (TODO)', async () => {
    const project = await projectInTddFlow();
    const item = (await request(app).post('/items').send({
      projectId: project.id, type: 'TASK', title: 'todo task', status: 'TODO',
    })).body;

    const res = await request(app).post(`/items/${item.id}/pause`).send({
      summary: 's', resumeInstructions: 'r',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active working step|cannot pause/i);
  });
});
