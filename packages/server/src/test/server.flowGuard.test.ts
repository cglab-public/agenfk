/**
 * Tests for the local Flow read-only guard.
 *
 * When a flow has source='hub', the local server treats it as managed by the
 * org's corp Hub: any local mutation through REST (and therefore MCP, which
 * proxies REST) returns 409. New writes default to source='local' and refuse
 * to honour a body-supplied source override.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, initStorage, storage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./flow-guard-test-db.sqlite');

describe('local flow read-only guard', () => {
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

  const baseSteps = [
    { id: 's1', name: 'TODO', label: 'TODO', order: 1, isAnchor: true },
    { id: 's2', name: 'WORK', label: 'Work', order: 2 },
    { id: 's3', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
  ];

  it("POST /flows defaults source to 'local'", async () => {
    const r = await request(app).post('/flows').send({ name: 'LF', steps: baseSteps });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe('local');
  });

  it("POST /flows refuses to honour a body-supplied source='hub'", async () => {
    const r = await request(app).post('/flows').send({
      name: 'sneaky', steps: baseSteps, source: 'hub', hubFlowId: 'fake', hubVersion: 99,
    });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe('local');
    expect(r.body.hubFlowId).toBeUndefined();
    expect(r.body.hubVersion).toBeUndefined();
  });

  it('PUT /flows/:id is allowed for source=local flows', async () => {
    const created = (await request(app).post('/flows').send({ name: 'L', steps: baseSteps })).body;
    const r = await request(app).put(`/flows/${created.id}`).send({ name: 'L2' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('L2');
  });

  it('DELETE /flows/:id is allowed for source=local flows', async () => {
    const created = (await request(app).post('/flows').send({ name: 'L', steps: baseSteps })).body;
    const r = await request(app).delete(`/flows/${created.id}`);
    expect(r.status).toBe(204);
  });

  it("PUT /flows/:id returns 409 when flow.source === 'hub'", async () => {
    // Seed a hub-managed flow directly via storage (the path the future
    // reconciler will use).
    const hubFlow = await storage.createFlow({
      id: 'hub-1',
      name: 'Hub Mandated',
      description: '',
      version: '1',
      steps: baseSteps,
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'hub' as any,
      hubFlowId: 'remote-hub-1' as any,
      hubVersion: 1 as any,
    } as any);
    expect((hubFlow as any).source).toBe('hub');

    const r = await request(app).put(`/flows/${hubFlow.id}`).send({ name: 'pwn' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/managed by your organization's Hub/i);
  });

  it("DELETE /flows/:id returns 409 when flow.source === 'hub'", async () => {
    const hubFlow = await storage.createFlow({
      id: 'hub-2',
      name: 'Hub Mandated',
      description: '',
      version: '1',
      steps: baseSteps,
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'hub' as any,
    } as any);

    const r = await request(app).delete(`/flows/${hubFlow.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/managed by your organization's Hub/i);
  });

  it("hub-managed flow round-trips its source field through GET /flows/:id", async () => {
    await storage.createFlow({
      id: 'hub-3',
      name: 'Hub',
      description: '',
      version: '1',
      steps: baseSteps,
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'hub' as any,
      hubFlowId: 'remote-hub-3' as any,
      hubVersion: 7 as any,
    } as any);
    const r = await request(app).get('/flows/hub-3');
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('hub');
    expect(r.body.hubFlowId).toBe('remote-hub-3');
    expect(r.body.hubVersion).toBe(7);
  });
});
