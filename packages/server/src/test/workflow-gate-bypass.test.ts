/**
 * CGLAB-81 — the workflow gate must not be bypassable.
 *
 * The framework's central guarantee is that an item only moves forward through
 * `validate_progress`, which records evidence and evaluates the step's exit
 * criteria. Four routes defeated that. These drive the real Express app so they
 * fail if the guarantee regresses, rather than asserting on source text.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, buildAllowedTransitions } from '../server';

const TEST_DB = path.resolve('./workflow-gate-bypass-test-db.sqlite');

const flow = (steps: Array<{ name: string; order: number; isAnchor?: boolean }>) => ({ steps });

describe('buildAllowedTransitions cannot be used to skip steps (CGLAB-81)', () => {
  const five = flow([
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'IN_PROGRESS', order: 1 },
    { name: 'REVIEW', order: 2 },
    { name: 'TEST', order: 3 },
    { name: 'DONE', order: 4, isAnchor: true },
  ]);

  it('does not let a platform status launder a jump to the final step', () => {
    // update --status PAUSED, then update --status TEST used to be two legal
    // writes that skipped every intermediate gate.
    const allowed = buildAllowedTransitions('PAUSED', five);
    expect(allowed.has('TEST')).toBe(false);
    expect(allowed.has('REVIEW')).toBe(false);
  });

  it('still lets a platform status return to somewhere workable', () => {
    const allowed = buildAllowedTransitions('PAUSED', five);
    expect(allowed.has('IN_PROGRESS')).toBe(true);
    expect(allowed.has('TODO')).toBe(true);
  });

  it('does not open every step when the current status is unknown to the flow', () => {
    const allowed = buildAllowedTransitions('SOME_RETIRED_STEP', five);
    expect(allowed.has('TEST')).toBe(false);
    expect(allowed.has('REVIEW')).toBe(false);
    // but recovery must remain possible
    expect(allowed.has('IN_PROGRESS')).toBe(true);
  });

  it('still permits an ordinary one-step move in each direction', () => {
    const allowed = buildAllowedTransitions('REVIEW', five);
    expect(allowed.has('TEST')).toBe(true);
    expect(allowed.has('IN_PROGRESS')).toBe(true);
  });
});

describe('the HTTP surface enforces the gate (CGLAB-81)', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    const p = await request(app).post('/projects').send({ name: 'gate-test' });
    projectId = p.body.id;
  });

  const newItem = async () => {
    const r = await request(app).post('/items').send({ type: 'TASK', title: 'gate', projectId });
    return r.body.id;
  };

  it('rejects a multi-step forward jump on a project with NO custom flow', async () => {
    // The check used to run only `if (projectFlowId)`, so default-flow projects
    // — the majority — got no validation at all.
    const id = await newItem();
    const res = await request(app).put(`/items/${id}`).send({ status: 'TEST' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/FLOW VIOLATION/i);
  });

  it('still allows a legitimate one-step move on a default-flow project', async () => {
    const id = await newItem();
    const res = await request(app).put(`/items/${id}`).send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('refuses to reach DONE through a plain status write, from any step', async () => {
    // The plain-PUT guard predates this work, so asserting only that would be
    // vacuous. What changed is that there is no longer a step from which DONE is
    // reachable without validate_progress — including the last one before it,
    // which used to be the sanctioned launderer.
    const id = await newItem();
    for (const s of ['IN_PROGRESS', 'REVIEW', 'TEST']) {
      await request(app).put(`/items/${id}`).send({ status: s });
    }
    const fromFinal = await request(app).put(`/items/${id}`).send({ status: 'DONE' });
    expect(fromFinal.status).toBeGreaterThanOrEqual(400);
    expect((await request(app).get(`/items/${id}`)).body.status).toBe('TEST');
  });

  it('cannot launder a jump through PAUSED', async () => {
    const id = await newItem();
    await request(app).put(`/items/${id}`).send({ status: 'IN_PROGRESS' });
    const paused = await request(app).put(`/items/${id}`).send({ status: 'PAUSED' });
    expect(paused.status).toBe(200);
    const jump = await request(app).put(`/items/${id}`).send({ status: 'TEST' });
    expect(jump.status).toBe(400);
  });

  it('applies the same validation on the bulk route', async () => {
    const id = await newItem();
    const res = await request(app).post('/items/bulk').send({
      items: [{ id, updates: { status: 'TEST' } }],
    });
    // What must NOT happen is the item silently landing on TEST, and the caller
    // must be TOLD rather than left to assume it worked.
    const after = await request(app).get(`/items/${id}`);
    expect(after.body.status).not.toBe('TEST');
    expect(JSON.stringify(res.body)).toMatch(/FLOW VIOLATION/i);
  });
});
