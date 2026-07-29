/**
 * BUG 269eeec8 defect (c) — contract parity between the local server and the Hub.
 *
 * The Hub validates flow-definition shape (packages/hub/src/routes/admin.ts
 * validateDefinition: every step needs a non-empty id, a non-empty name, and a
 * numeric order). The local server validated none of it, so a flow authored
 * locally could be persisted with an empty step name and then fail to publish to
 * the Hub with an opaque 400. Worse, an empty step name is a broken workflow
 * status in its own right — nothing can transition an item to "".
 *
 * These tests hold the local server to the same contract.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./flow-step-validation-test-db.sqlite');

describe('local flow step-shape validation', () => {
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
  });

  const baseSteps = () => [
    { id: 's1', name: 'TODO', label: 'TODO', order: 0, isAnchor: true },
    { id: 's2', name: 'WORK', label: 'Work', order: 1 },
    { id: 's3', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ];

  const createFlow = async () => {
    const r = await request(app).post('/flows').send({ name: 'LF', steps: baseSteps() });
    expect(r.status).toBe(201);
    return r.body;
  };

  it('POST /flows rejects a step with an empty name', async () => {
    const steps = baseSteps();
    steps[1] = { ...steps[1], name: '' };
    const r = await request(app).post('/flows').send({ name: 'Bad', steps });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
  });

  it('POST /flows rejects a whitespace-only step name', async () => {
    const steps = baseSteps();
    steps[1] = { ...steps[1], name: '   ' };
    const r = await request(app).post('/flows').send({ name: 'Bad', steps });
    expect(r.status).toBe(400);
  });

  // Callers (MCP create_flow, the CLI) have always been allowed to omit step
  // ids, so generate them rather than rejecting: the Hub requires a non-empty
  // id, and generating is what makes a locally-authored flow publishable.
  it('POST /flows generates an id for a step that omits one', async () => {
    const steps = baseSteps().map(({ id: _id, ...rest }) => rest);
    const r = await request(app).post('/flows').send({ name: 'NoIds', steps });
    expect(r.status).toBe(201);
    const ids = r.body.steps.map((s: any) => s.id);
    expect(ids.every((id: unknown) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it('POST /flows generates an id for a step whose id is blank', async () => {
    const steps = baseSteps();
    steps[1] = { ...steps[1], id: '' };
    const r = await request(app).post('/flows').send({ name: 'BlankId', steps });
    expect(r.status).toBe(201);
    expect(r.body.steps[1].id).toBeTruthy();
  });

  it('PUT /flows/:id generates an id for a step that omits one', async () => {
    const flow = await createFlow();
    const steps = baseSteps().map(({ id: _id, ...rest }) => rest);
    const r = await request(app).put(`/flows/${flow.id}`).send({ name: 'LF', steps });
    expect(r.status).toBe(200);
    expect(r.body.steps.every((s: any) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
  });

  it('POST /flows rejects a non-numeric step order', async () => {
    const steps = baseSteps();
    steps[1] = { ...steps[1], order: 'second' as unknown as number };
    const r = await request(app).post('/flows').send({ name: 'Bad', steps });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/order/i);
  });

  // Long-standing local behaviour: create an empty flow, populate it later.
  // The Hub refuses an empty definition, so such a flow is un-publishable until
  // it has steps — but it is not invalid locally, and callers rely on this.
  it('POST /flows still accepts an empty steps array', async () => {
    const r = await request(app).post('/flows').send({ name: 'Draft', steps: [] });
    expect(r.status).toBe(201);
    expect(r.body.steps).toEqual([]);
  });

  it('POST /flows rejects a non-array steps value', async () => {
    const r = await request(app).post('/flows').send({ name: 'Bad', steps: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/array/i);
  });

  it('PUT /flows/:id rejects a step with an empty name', async () => {
    const flow = await createFlow();
    const steps = baseSteps();
    steps[1] = { ...steps[1], name: '' };
    const r = await request(app).put(`/flows/${flow.id}`).send({ name: 'LF', steps });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
  });

  it('PUT /flows/:id does not persist a rejected step list', async () => {
    const flow = await createFlow();
    const steps = baseSteps();
    steps[1] = { ...steps[1], name: '' };
    await request(app).put(`/flows/${flow.id}`).send({ name: 'LF', steps });

    const after = await request(app).get(`/flows/${flow.id}`);
    expect(after.status).toBe(200);
    expect(after.body.steps.map((s: any) => s.name)).toEqual(['TODO', 'WORK', 'DONE']);
  });

  it('PUT /flows/:id still accepts a valid step list', async () => {
    const flow = await createFlow();
    const steps = baseSteps();
    steps[1] = { ...steps[1], name: 'REFACTOR', label: 'Refactor' };
    const r = await request(app).put(`/flows/${flow.id}`).send({ name: 'LF', steps });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: any) => s.name)).toEqual(['TODO', 'REFACTOR', 'DONE']);
  });

  it('PUT /flows/:id leaves steps untouched when the body omits them', async () => {
    const flow = await createFlow();
    const r = await request(app).put(`/flows/${flow.id}`).send({ name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Renamed');
    expect(r.body.steps.map((s: any) => s.name)).toEqual(['TODO', 'WORK', 'DONE']);
  });

  // Review finding: two steps sharing an id collide on React's key={step.id} in
  // the flow editor, silently dropping a column.
  it('PUT /flows/:id replaces duplicate step ids with fresh ones', async () => {
    const flow = await createFlow();
    const steps = baseSteps().map(s => ({ ...s, id: 'same' }));
    const r = await request(app).put(`/flows/${flow.id}`).send({ name: 'LF', steps });
    expect(r.status).toBe(200);
    const ids = r.body.steps.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('PUT /flows/:id keeps caller-supplied ids that are already unique', async () => {
    const flow = await createFlow();
    const r = await request(app).put(`/flows/${flow.id}`).send({ name: 'LF', steps: baseSteps() });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: any) => s.id)).toEqual(['s1', 's2', 's3']);
  });
});
