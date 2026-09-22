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

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call. That
 * churn produced `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` — a
 * transport failure, not an assertion about anything under test. It hands the
 * test an empty body, so `res.body.id` is undefined and the next call goes to
 * `/items/undefined`; one bad socket then surfaces as `expected 404 to be 400`
 * in whichever test happened to be running. Different test every run, green
 * when run alone.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


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
    const p = await agent().post('/projects').send({ name: 'custom-flow-proj' });
    projectId = p.body.id;

    // A flow that shares no intermediate step name with the defaults.
    const f = await agent().post('/flows').send({
      name: 'Spec Flow',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'SPEC', label: 'Spec', order: 1 },
        { name: 'CODE', label: 'Code', order: 2 },
        { name: 'QA', label: 'QA', order: 3 },
        { name: 'DONE', label: 'Done', order: 4, isAnchor: true },
      ],
    });
    await agent().post(`/projects/${projectId}/flow`).send({ flowId: f.body.id });
  });

  it('rolls the parent forward once every child has reached a step', async () => {
    const parent = await agent().post('/items').send({ type: 'STORY', title: 'parent', projectId });
    const a = await agent().post('/items').send({ type: 'TASK', title: 'a', projectId, parentId: parent.body.id });
    const b = await agent().post('/items').send({ type: 'TASK', title: 'b', projectId, parentId: parent.body.id });

    // Walk both children one step at a time (one-step moves are legal).
    for (const id of [a.body.id, b.body.id]) {
      await agent().put(`/items/${id}`).send({ status: 'SPEC' });
      await agent().put(`/items/${id}`).send({ status: 'CODE' });
    }

    const after = await agent().get(`/items/${parent.body.id}`);
    // The parent must not still be sitting at TODO while both children are on CODE.
    expect(after.body.status).not.toBe('TODO');
    expect(['SPEC', 'CODE']).toContain(after.body.status);
  });

  it('does not outrun the least-advanced child', async () => {
    const parent = await agent().post('/items').send({ type: 'STORY', title: 'parent2', projectId });
    const a = await agent().post('/items').send({ type: 'TASK', title: 'a2', projectId, parentId: parent.body.id });
    await agent().post('/items').send({ type: 'TASK', title: 'b2', projectId, parentId: parent.body.id });

    await agent().put(`/items/${a.body.id}`).send({ status: 'SPEC' });
    await agent().put(`/items/${a.body.id}`).send({ status: 'CODE' });

    const after = await agent().get(`/items/${parent.body.id}`);
    // One child is still at TODO, so the parent cannot claim CODE.
    expect(after.body.status).not.toBe('CODE');
  });
});
