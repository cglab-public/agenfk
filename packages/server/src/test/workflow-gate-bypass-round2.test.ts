/**
 * Round-two review of CGLAB-81 found four more routes and two regressions the
 * first pass introduced. Same principle: an item only moves forward through
 * validate_progress, and a flow is untrusted input.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, buildAllowedTransitions } from '../server';

const TEST_DB = path.resolve('./workflow-gate-round2-test-db.sqlite');

describe('routes that still reached DONE (CGLAB-81 round 2)', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    projectId = (await request(app).post('/projects').send({ name: 'round2' })).body.id;
  });

  it('refuses to create an item already at DONE', async () => {
    // MCP create_item advertises `status`, so this was documented and free.
    const res = await request(app).post('/items').send({
      type: 'TASK', title: 'born done', projectId, status: 'DONE',
    });
    if (res.status < 400) expect(res.body.status).not.toBe('DONE');
  });

  it('DOES allow creating an item parked in a working step', async () => {
    // Deliberately permitted, and the rule was relaxed to get here: importing
    // from JIRA or GitHub brings items in whatever state they are already in,
    // and parking an item mid-flow is normal. Two pre-existing tests rely on it.
    // Only COMPLETION has to be earned through validate_progress, so DONE and
    // the flow's exit anchor are the only statuses refused on create.
    const res = await request(app).post('/items').send({
      type: 'TASK', title: 'parked', projectId, status: 'TEST',
    });
    expect(res.status).toBeLessThan(400);
    expect(res.body.status).toBe('TEST');
  });

  it('refuses to create an item on the exit anchor, whatever it is named', async () => {
    const f = await request(app).post('/flows').send({
      name: 'Custom Exit',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'BUILD', label: 'Build', order: 1 },
        { name: 'SHIPPED', label: 'Shipped', order: 2, isAnchor: true },
      ],
    });
    await request(app).post(`/projects/${projectId}/flow`).send({ flowId: f.body.id });
    const res = await request(app).post('/items').send({
      type: 'TASK', title: 'born shipped', projectId, status: 'SHIPPED',
    });
    if (res.status < 400) expect(res.body.status).not.toBe('SHIPPED');
  });

  it('does not let a flow assignment migrate items onto DONE', async () => {
    // migrateCardsToFlow maps positionally, so a flow whose FIRST step is named
    // DONE mapped every TODO item straight onto it — project-wide, one request,
    // and the flow may have come from the registry or an org-wide hub push.
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'x', projectId })).body;
    const hostile = await request(app).post('/flows').send({
      name: 'Hostile Positional',
      steps: [
        { name: 'DONE', label: 'Done', order: 0, isAnchor: true },
        { name: 'WORK', label: 'Work', order: 1 },
        { name: 'FINISHED', label: 'Finished', order: 2, isAnchor: true },
      ],
    });
    await request(app).post(`/projects/${projectId}/flow`).send({ flowId: hostile.body.id });
    const after = await request(app).get(`/items/${item.id}`);
    expect(after.body.status).not.toBe('DONE');
  });

  it('cannot teleport through a stale pause snapshot', async () => {
    // Snapshots survived resume, and PUT status=PAUSED creates none — so any
    // step ever paused at became a permanent teleport token.
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'tp', projectId })).body;
    for (const s of ['IN_PROGRESS', 'REVIEW', 'TEST']) {
      await request(app).put(`/items/${item.id}`).send({ status: s });
    }
    await request(app).post(`/items/${item.id}/pause`).send({ summary: 's', resumeInstructions: 'r' });
    await request(app).post(`/items/${item.id}/resume`).send({});
    // Walk back to the coding step, then pause+resume again.
    for (const s of ['REVIEW', 'IN_PROGRESS']) {
      await request(app).put(`/items/${item.id}`).send({ status: s });
    }
    await request(app).put(`/items/${item.id}`).send({ status: 'PAUSED' });
    await request(app).post(`/items/${item.id}/resume`).send({});
    const after = await request(app).get(`/items/${item.id}`);
    expect(after.body.status).not.toBe('TEST');
  });
});

describe('platform-status target is positionally adjacent (CGLAB-81 round 2)', () => {
  it('does not offer a deep step just because earlier ones are anchors', () => {
    const anchorHeavy = { steps: [
      { name: 'TODO', order: 0, isAnchor: true },
      { name: 'PLAN', order: 1, isAnchor: true },
      { name: 'SPEC', order: 2, isAnchor: true },
      { name: 'IMPL', order: 3 },
      { name: 'DONE', order: 4, isAnchor: true },
    ] };
    const allowed = buildAllowedTransitions('PAUSED', anchorHeavy);
    expect(allowed.has('IMPL')).toBe(false);
    expect(allowed.has('PLAN')).toBe(true);
  });

  it('never offers the exit anchor from a platform status', () => {
    const twoAnchor = { steps: [
      { name: 'TODO', order: 0, isAnchor: true },
      { name: 'DONE', order: 1, isAnchor: true },
    ] };
    expect(buildAllowedTransitions('PAUSED', twoAnchor).has('DONE')).toBe(false);
  });
});

describe('parent propagation stays safe (CGLAB-82 round 2)', () => {
  let projectId: string;
  beforeEach(async () => {
    await initStorage();
    projectId = (await request(app).post('/projects').send({ name: 'pp2' })).body.id;
  });

  it('does not un-pause a parent when a child is merely edited', async () => {
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'p', projectId })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'c', projectId, parentId: parent.id })).body;
    await request(app).put(`/items/${parent.id}`).send({ status: 'PAUSED' });
    await request(app).put(`/items/${child.id}`).send({ title: 'renamed only' });
    const after = await request(app).get(`/items/${parent.id}`);
    expect(after.body.status).toBe('PAUSED');
  });

  it('never writes a platform status onto a parent from a flow step', async () => {
    const f = await request(app).post('/flows').send({
      name: 'Platform Named',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'BLOCKED', label: 'Blocked', order: 1 },
        { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
      ],
    });
    await request(app).post(`/projects/${projectId}/flow`).send({ flowId: f.body.id });
    const parent = (await request(app).post('/items').send({ type: 'STORY', title: 'p2', projectId })).body;
    const child = (await request(app).post('/items').send({ type: 'TASK', title: 'c2', projectId, parentId: parent.id })).body;
    await request(app).put(`/items/${child.id}`).send({ status: 'BLOCKED' });
    const after = await request(app).get(`/items/${parent.id}`);
    expect(after.body.status).not.toBe('BLOCKED');
  });
});
