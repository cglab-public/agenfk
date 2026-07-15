/**
 * TASK 2dd30da3 — `GET /items?active=true` (surfaced as `agenfk list --active`).
 *
 * Init's resume-check pulled ALL items (every DONE included), so an agent's
 * context grew unbounded as the board filled. `active=true` returns only items
 * in an active working step, reusing core `getActiveStepItems` so it agrees
 * with the gatekeeper: excludes the flow's anchors (TODO/DONE) and the
 * INACTIVE_STATUSES (BLOCKED/PAUSED/TRASHED/ARCHIVED/IDEAS). Flow-aware: the
 * server resolves each item's project flow, so custom flows work too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./server-list-active-test-db.sqlite');

const idsByStatus = async (projectId: string, query: Record<string, string>) => {
  const res = await request(app).get('/items').query({ projectId, ...query });
  expect(res.status).toBe(200);
  return res.body as Array<{ id: string; status: string }>;
};

async function makeItem(projectId: string, title: string, status: string): Promise<string> {
  const created = (await request(app).post('/items').send({ projectId, type: 'TASK', title })).body;
  // Set the target status directly through storage to bypass the server's
  // forward-transition guards (we need items parked in DONE/PAUSED/etc.).
  await storage.updateItem(created.id, { status: status as any });
  return created.id;
}

describe('GET /items?active=true', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
    await initStorage();
  });
  afterAll(() => {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  });

  it('default flow: returns only working-step items (IN_PROGRESS/REVIEW/TEST)', async () => {
    const projectId = (await request(app).post('/projects').send({ name: 'DefaultFlowActive' })).body.id;
    const todo = await makeItem(projectId, 'todo', 'TODO');
    const inprog = await makeItem(projectId, 'inprog', 'IN_PROGRESS');
    const review = await makeItem(projectId, 'review', 'REVIEW');
    const test = await makeItem(projectId, 'test', 'TEST');
    const done = await makeItem(projectId, 'done', 'DONE');
    const paused = await makeItem(projectId, 'paused', 'PAUSED');
    const blocked = await makeItem(projectId, 'blocked', 'BLOCKED');
    const archived = await makeItem(projectId, 'archived', 'ARCHIVED');

    const active = await idsByStatus(projectId, { active: 'true' });
    const activeIds = active.map(i => i.id).sort();
    expect(activeIds).toEqual([inprog, review, test].sort());
    // Explicitly assert the excluded ones are gone.
    for (const excluded of [todo, done, paused, blocked, archived]) {
      expect(activeIds).not.toContain(excluded);
    }
  });

  it('does not re-admit ARCHIVED/TRASHED under active (guard holds even though a filter is set)', async () => {
    const projectId = (await request(app).post('/projects').send({ name: 'ActiveNoArchived' })).body.id;
    await makeItem(projectId, 'arch', 'ARCHIVED');
    await makeItem(projectId, 'trash', 'TRASHED');
    const inprog = await makeItem(projectId, 'inprog', 'IN_PROGRESS');

    const active = await idsByStatus(projectId, { active: 'true' });
    expect(active.map(i => i.id)).toEqual([inprog]);
  });

  it('custom flow: excludes anchors, returns custom working steps (flow-aware)', async () => {
    const projectId = (await request(app).post('/projects').send({ name: 'CustomFlowActive' })).body.id;
    const flow = (await request(app).post('/flows').send({
      name: 'TDD-active',
      steps: [
        { id: 'a', name: 'TODO', order: 1, isAnchor: true },
        { id: 'b', name: 'DISCOVERY', order: 2, exitCriteria: 'Scope clear' },
        { id: 'c', name: 'IN_PROGRESS', order: 3 },
        { id: 'd', name: 'DONE', order: 4, isAnchor: true },
      ],
    })).body;
    await request(app).post(`/projects/${projectId}/flow`).send({ flowId: flow.id });

    const todo = await makeItem(projectId, 'todo', 'TODO');
    const discovery = await makeItem(projectId, 'disc', 'DISCOVERY');
    const inprog = await makeItem(projectId, 'inprog', 'IN_PROGRESS');
    const done = await makeItem(projectId, 'done', 'DONE');

    const active = await idsByStatus(projectId, { active: 'true' });
    const activeIds = active.map(i => i.id).sort();
    expect(activeIds).toEqual([discovery, inprog].sort());
    expect(activeIds).not.toContain(todo);
    expect(activeIds).not.toContain(done);
  });

  it('plain list (no active) still returns DONE — active is opt-in', async () => {
    const projectId = (await request(app).post('/projects').send({ name: 'PlainListUnchanged' })).body.id;
    const done = await makeItem(projectId, 'done', 'DONE');
    const inprog = await makeItem(projectId, 'inprog', 'IN_PROGRESS');
    const all = await idsByStatus(projectId, {});
    const allIds = all.map(i => i.id);
    expect(allIds).toContain(done);
    expect(allIds).toContain(inprog);
  });
});
