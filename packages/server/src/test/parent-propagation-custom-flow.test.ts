/**
 * CGLAB-82 — a parent must roll forward on ANY flow.
 *
 * syncParentStatus compared children against Status.IN_PROGRESS/REVIEW/TEST/DONE
 * by name, so on a custom flow no intermediate branch could ever fire and a
 * parent silently lagged behind its children forever. Only allDone -> DONE
 * worked, because DONE is an anchor every flow has.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

const TEST_DB = path.resolve('./parent-propagation-custom-flow-test-db.sqlite');

describe('parent propagation on a custom flow (CGLAB-82)', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  beforeEach(async () => {
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'custom-flow-proj' });
    projectId = p.body.id;

    // A flow that shares no intermediate step name with the defaults.
    const f = await request(app).post('/flows').send({
      name: 'Spec Flow',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'SPEC', label: 'Spec', order: 1 },
        { name: 'CODE', label: 'Code', order: 2 },
        { name: 'QA', label: 'QA', order: 3 },
        { name: 'DONE', label: 'Done', order: 4, isAnchor: true },
      ],
    });
    await request(app).post(`/projects/${projectId}/flow`).send({ flowId: f.body.id });
  });

  it('rolls the parent forward once every child has reached a step', async () => {
    const parent = await request(app).post('/items').send({ type: 'STORY', title: 'parent', projectId });
    const a = await request(app).post('/items').send({ type: 'TASK', title: 'a', projectId, parentId: parent.body.id });
    const b = await request(app).post('/items').send({ type: 'TASK', title: 'b', projectId, parentId: parent.body.id });

    // Walk both children one step at a time (one-step moves are legal).
    for (const id of [a.body.id, b.body.id]) {
      await request(app).put(`/items/${id}`).send({ status: 'SPEC' });
      await request(app).put(`/items/${id}`).send({ status: 'CODE' });
    }

    const after = await request(app).get(`/items/${parent.body.id}`);
    // The parent must not still be sitting at TODO while both children are on CODE.
    expect(after.body.status).not.toBe('TODO');
    expect(['SPEC', 'CODE']).toContain(after.body.status);
  });

  it('does not outrun the least-advanced child', async () => {
    const parent = await request(app).post('/items').send({ type: 'STORY', title: 'parent2', projectId });
    const a = await request(app).post('/items').send({ type: 'TASK', title: 'a2', projectId, parentId: parent.body.id });
    await request(app).post('/items').send({ type: 'TASK', title: 'b2', projectId, parentId: parent.body.id });

    await request(app).put(`/items/${a.body.id}`).send({ status: 'SPEC' });
    await request(app).put(`/items/${a.body.id}`).send({ status: 'CODE' });

    const after = await request(app).get(`/items/${parent.body.id}`);
    // One child is still at TODO, so the parent cannot claim CODE.
    expect(after.body.status).not.toBe('CODE');
  });
});
