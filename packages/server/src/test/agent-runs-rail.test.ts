/**
 * @vitest-environment node
 *
 * The cross-project view of what agents are doing (CGLAB-170).
 *
 * `GET /items/:id/agent-runs` already exists, but it is per card. The Sessions
 * rail in the sidebar asks a different question — "what is running anywhere" —
 * and answering it by fetching every project's runs from the renderer would be
 * an N+1 over the socket on every event.
 *
 * One deliberate omission, stated here so nobody adds it by reflex: this route
 * does NOT decide liveness. `AgentRun.status` stays `'running'` forever,
 * because the hook never issues the closing PATCH (BUG df4b3343) — so a rail
 * that trusted it would show every run this machine has ever started. The
 * server reports what it stored; the client decides what counts as live from
 * the recency of `run:event`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./agent-runs-rail-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

describe('GET /agent-runs', () => {
  let projectA: string;
  let projectB: string;
  let itemA: string;
  let itemB: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  beforeEach(async () => {
    await initStorage();
    const a = await internal(request(app).post('/projects')).send({ name: 'alpha' });
    const b = await internal(request(app).post('/projects')).send({ name: 'beta' });
    projectA = a.body.id;
    projectB = b.body.id;
    const ia = await internal(request(app).post('/items')).send({ type: 'TASK', title: 'in alpha', projectId: projectA });
    const ib = await internal(request(app).post('/items')).send({ type: 'TASK', title: 'in beta', projectId: projectB });
    itemA = ia.body.id;
    itemB = ib.body.id;
  });

  /**
   * A run always STARTS as running — the create route fixes the status, which
   * is right: a run that begins already failed is not a thing. Reaching any
   * other status goes through the PATCH, like it does in production.
   */
  const makeRun = async (itemId: string, projectId: string, endAs?: 'done' | 'failed') => {
    const res = await internal(request(app).post('/agent-runs')).send({
      itemId, projectId, step: 'IN_PROGRESS', actor: 'worker',
      harness: 'claude-code', model: 'claude-opus-5',
    });
    if (endAs) {
      await internal(request(app).patch(`/agent-runs/${res.body.id}`)).send({ status: endAs });
    }
    return res;
  };

  it('returns runs from every project, which is the whole point', async () => {
    // Per-card fetching from the renderer would be an N+1 over the socket on
    // every event; this is the query that makes the rail possible at all.
    await makeRun(itemA, projectA);
    await makeRun(itemB, projectB);

    const res = await request(app).get('/agent-runs').query({ limit: 200 });
    expect(res.status).toBe(200);
    const projects = res.body.map((r: { projectId: string }) => r.projectId);
    expect(projects).toEqual(expect.arrayContaining([projectA, projectB]));
  });

  it('can be narrowed to one project', async () => {
    await makeRun(itemA, projectA);
    await makeRun(itemB, projectB);

    const res = await request(app).get('/agent-runs').query({ projectId: projectA });
    expect(res.body.every((r: { projectId: string }) => r.projectId === projectA)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('can be narrowed by status', async () => {
    await makeRun(itemA, projectA);
    await makeRun(itemB, projectB, 'failed');

    // Scoped to this test's own projects: the database persists across tests
    // in this file, so an unscoped query would count every earlier run.
    const res = await request(app).get('/agent-runs').query({ status: 'failed', projectId: projectB });
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('failed');
  });

  it('refuses a status that is not a run status', async () => {
    // The value reaches a storage query. Passing it through unchecked is how a
    // filter becomes an injection point.
    const res = await request(app).get('/agent-runs').query({ status: 'DROP TABLE' });
    expect(res.status).toBe(400);
  });

  it('carries what a session row needs to render', async () => {
    // harness and model name the agent, step gives the flow step, startedAt
    // drives the elapsed clock. All of it is already stored — the rail should
    // not have to make a second request per row.
    await makeRun(itemA, projectA);
    const [run] = (await request(app).get('/agent-runs').query({ projectId: projectA })).body;
    for (const field of ['id', 'itemId', 'projectId', 'step', 'harness', 'model', 'status', 'startedAt']) {
      expect(run[field], `a session row cannot render without ${field}`).toBeDefined();
    }
  });

  it('bounds how much it will return', async () => {
    // A machine that has been running agents for months would otherwise send
    // its whole history to render a sidebar.
    for (let i = 0; i < 30; i += 1) await makeRun(itemA, projectA);
    const res = await request(app).get('/agent-runs').query({ limit: 5, projectId: projectA });
    expect(res.body).toHaveLength(5);
  });

  it('applies a default bound when none is asked for', async () => {
    for (let i = 0; i < 30; i += 1) await makeRun(itemA, projectA);
    const res = await request(app).get('/agent-runs');
    expect(res.body.length).toBeLessThanOrEqual(25);
  });

  it('refuses an absurd limit rather than honouring it', async () => {
    const res = await request(app).get('/agent-runs').query({ limit: 100000 });
    expect(res.status).toBe(400);
  });

  it('returns an empty list, not an error, when nothing has run', async () => {
    // Scoped to a project created for this test, because the file shares one
    // database — an unscoped assertion here would be testing the leftovers of
    // whichever test happened to run before it.
    const fresh = await internal(request(app).post('/projects')).send({ name: 'untouched' });
    const res = await request(app).get('/agent-runs').query({ projectId: fresh.body.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('does not pretend to know what is live', async () => {
    // Deliberate. AgentRun.status stays 'running' forever because the hook
    // never issues the closing PATCH (BUG df4b3343), so a server-side "live"
    // filter would report every run this machine ever started. The client
    // decides liveness from the recency of run:event.
    await makeRun(itemA, projectA);
    const res = await request(app).get('/agent-runs').query({ status: 'running', projectId: projectA });
    expect(res.body).toHaveLength(1);
    // It reports what it stored, with no liveness field invented on top.
    expect(res.body[0]).not.toHaveProperty('live');
    expect(res.body[0]).not.toHaveProperty('isActive');
  });
});
