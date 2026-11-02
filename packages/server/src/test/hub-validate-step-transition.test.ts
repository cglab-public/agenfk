/**
 * Hub closure events, pinned by behaviour (BUG dfb85b2f).
 *
 * The hub rolls up closed items from `step.transitioned` events whose
 * `payload.toStatus` is DONE (packages/hub/src/rollup.ts), and the hub UI
 * filters closures by the separate `item.closed` event. A card is closed by
 * validate_progress, never by PUT: since CGLAB-377 PUT /items/:id refuses
 * every route into DONE, so it must emit neither.
 *
 * This file used to count occurrences of `type: 'item.closed'` in server.ts,
 * which kept an unreachable PUT branch alive only because deleting it lowered
 * the count. It now drives the real routes and reads hub_outbox.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});
vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('hub-validate-step-transition-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { posixShell } from './helpers/posixShell';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * recordHubEvent enqueues without being awaited by the route, so poll. Up to
 * 5 s: the first event of a project waits on its git remote lookup (bounded at
 * 1.5 s), which a loaded Windows box can take in full (#208). Returns as soon as
 * the closure is there.
 */
async function outboxFor(itemId: string, settleMs = 5000): Promise<any[]> {
  const db: any = (storage as any)['database'];
  const deadline = Date.now() + settleMs;
  let events: any[] = [];
  while (Date.now() < deadline) {
    events = (db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).filter(e => e.itemId === itemId);
    if (events.some(e => e.type === 'item.closed')) return events;
    await new Promise(r => setTimeout(r, 25));
  }
  return events;
}

let seq = 0;
async function cardAt(status: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-close-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  const p = await agent().post('/projects').send({ name: `close-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: dir, verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `close-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}

describe('closing a card emits the hub closure events', () => {
  it('validate landing DONE emits step.transitioned with toStatus DONE (unstamped on the shipped default flow), and item.closed', async () => {
    const id = await cardAt('TEST');
    const res = await agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('DONE');

    const events = await outboxFor(id);
    const transitioned = events.find(e => e.type === 'step.transitioned' && e.payload?.toStatus === 'DONE');
    expect(transitioned, JSON.stringify(events.map(e => e.type))).toBeDefined();
    // CGLAB-612: a project on the shipped default flow has no revision, so the event is unstamped.
    expect(transitioned.payload.flowId).toBeUndefined();
    expect(transitioned.payload.flowRevision).toBeUndefined();
    expect(transitioned.payload.compliant).toBeUndefined();
    const closed = events.find(e => e.type === 'item.closed');
    expect(closed).toBeDefined();
    expect(closed.payload).toMatchObject({ fromStatus: 'TEST', toStatus: 'DONE', itemType: 'TASK' });
  });

});

/** A project on its own flow, in its own clean repository. */
async function projectOn(steps: any[]) {
  const f = await agent().post('/flows').send({ name: `close-flow-${++seq}`, steps });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-close-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  const p = await agent().post('/projects').send({ name: `close-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return { projectId: p.body.id as string, dir };
}
const st = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${seq}`, name, label: name, order, ...extra });
const make = async (projectId: string, type: string, status: string, parentId?: string) => {
  const c = await agent().post('/items').send({ type, title: `${type}-${++seq}`, projectId, ...(parentId ? { parentId } : {}) });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
};
const verify = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' });

describe('every way a card reaches the end of its flow is a closure the hub sees (BUG a829ab35)', () => {
  it('a custom exit step not named DONE: item.closed names the step it closed on', async () => {
    const { projectId } = await projectOn([st('TODO', 0, { isAnchor: true }), st('WORK', 1), st('SHIPPED', 2, { isAnchor: true })]);
    const id = await make(projectId, 'TASK', 'WORK');
    const res = await verify(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('SHIPPED');
    const closed = (await outboxFor(id)).find(e => e.type === 'item.closed');
    expect(closed?.payload).toMatchObject({ fromStatus: 'WORK', toStatus: 'SHIPPED', itemType: 'TASK' });
  });

  it('a parent closed by the roll-up when its last child closes: step.transitioned and item.closed, after the child\'s, and only once', async () => {
    const { projectId } = await projectOn([st('TODO', 0, { isAnchor: true }), st('WORK', 1), st('DONE', 2, { isAnchor: true })]);
    const parent = await make(projectId, 'STORY', 'WORK');
    const child = await make(projectId, 'TASK', 'WORK', parent);
    expect((await verify(child)).status).toBe(200);
    expect((await agent().get(`/items/${parent}`)).body.status).toBe('DONE');
    const events = await outboxFor(parent);
    expect(events.find(e => e.type === 'step.transitioned')?.payload).toMatchObject({ fromStatus: 'WORK', toStatus: 'DONE', itemType: 'STORY' });
    expect(events.find(e => e.type === 'item.closed')?.payload).toMatchObject({ fromStatus: 'WORK', toStatus: 'DONE', itemType: 'STORY' });
    // The child's close is recorded before its parent's.
    const db: any = (storage as any)['database'];
    const order = (db.prepare('SELECT payload FROM hub_outbox ORDER BY rowid').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).filter(e => e.type === 'item.closed' && (e.itemId === child || e.itemId === parent)).map(e => e.itemId);
    expect(order).toEqual([child, parent]);
    // A parent closes once: a second child finishing runs the roll-up again over the closed parent, and emits nothing more.
    expect(events.filter(e => e.type === 'item.closed')).toHaveLength(1);
    const late = await make(projectId, 'TASK', 'WORK', parent);
    expect((await verify(late)).status).toBe(200);
    await new Promise(r => setTimeout(r, 300));
    expect((await outboxFor(parent, 300)).filter(e => e.type === 'item.closed')).toHaveLength(1);
  });

  it('a card closed by sibling propagation: step.transitioned and item.closed', async () => {
    const { projectId, dir } = await projectOn([st('TODO', 0, { isAnchor: true }), st('WORK', 1), st('DONE', 2, { isAnchor: true })]);
    const parent = await make(projectId, 'STORY', 'WORK');
    const done = await make(projectId, 'TASK', 'WORK', parent);
    const next = await make(projectId, 'TASK', 'WORK', parent);
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    await storage.updateItem(done, { status: 'DONE', tests: [{ id: 't1', command: 'exit 0', status: 'PASSED', executedAt: new Date(), commit: head }] } as any);
    const res = await verify(next);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/sibling propagation/i);
    const events = await outboxFor(next);
    expect(events.find(e => e.type === 'step.transitioned')?.payload).toMatchObject({ toStatus: 'DONE' });
    expect(events.find(e => e.type === 'item.closed')?.payload).toMatchObject({ fromStatus: 'WORK', toStatus: 'DONE', itemType: 'TASK' });
  });

});

/**
 * CGLAB-612 — every `step.transitioned` event carries the flow version it
 * happened under, plus a compliance verdict the hub can roll up.
 *
 * Two emitters produce the event (recordMoveEvents, and the PUT route — which
 * is the ROLLBACK path), so both are exercised here. `compliant` means BOTH
 * statuses are steps of the revision named by the event: there is NO direction
 * term, so a rollback between two steps of the same revision is compliant and
 * must not be penalised. A move to or from something that is not a step
 * (PAUSED, BLOCKED) is not compliant. A project on the shipped default flow
 * has no revision, so its events are unstamped and must carry no verdict.
 */
describe('CGLAB-612: step.transitioned carries the flow version and a compliance verdict', () => {
  const FLOW = () => [
    st('TODO', 0, { isAnchor: true }), st('PLAN', 1), st('WORK', 2), st('DONE', 3, { isAnchor: true }),
  ];
  const moved = (events: any[], to: string) => events.find(e => e.type === 'step.transitioned' && e.payload?.toStatus === to);

  it('stamps a forward move with the flow id, its revision, and compliant: true', async () => {
    const { projectId } = await projectOn(FLOW());
    const id = await make(projectId, 'TASK', 'PLAN');
    expect((await verify(id)).status).toBe(200); // PLAN -> WORK

    const ev = moved(await outboxFor(id, 500), 'WORK');
    expect(ev, 'no step.transitioned for PLAN -> WORK').toBeDefined();
    expect(ev.payload).toMatchObject({ fromStatus: 'PLAN', toStatus: 'WORK', itemType: 'TASK' });
    expect(typeof ev.payload.flowId).toBe('string');
    expect(ev.payload.flowRevision).toBe(1);
    expect(ev.payload.compliant).toBe(true);
  });

  it('a rollback between two steps of the same revision is COMPLIANT, not penalised', async () => {
    const { projectId } = await projectOn(FLOW());
    const id = await make(projectId, 'TASK', 'PLAN');
    expect((await verify(id)).status).toBe(200); // PLAN -> WORK

    const back = await agent().put(`/items/${id}`).send({ status: 'PLAN' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('PLAN');

    const ev = moved(await outboxFor(id, 500), 'PLAN');
    expect(ev, 'no step.transitioned for the rollback WORK -> PLAN').toBeDefined();
    expect(ev.payload).toMatchObject({ fromStatus: 'WORK', toStatus: 'PLAN' });
    expect(ev.payload.flowRevision).toBe(1);
    expect(ev.payload.compliant).toBe(true);
  });

  it('a move to a platform status that is not a step is NOT compliant', async () => {
    const { projectId } = await projectOn(FLOW());
    const id = await make(projectId, 'TASK', 'WORK');

    const paused = await agent().put(`/items/${id}`).send({ status: 'PAUSED' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const ev = moved(await outboxFor(id, 500), 'PAUSED');
    expect(ev, 'no step.transitioned for WORK -> PAUSED').toBeDefined();
    expect(ev.payload.flowRevision).toBe(1);
    expect(ev.payload.compliant).toBe(false);
  });
});

