/**
 * CGLAB-609 — the adherence endpoints count only versioned events.
 * Route-level: a project with mixed stamped/unstamped history scores from the
 * stamped events alone, judged against the revisions they name.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

const TEST_DB = testDbPath('flow-adherence-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage } from '../server';
import type { Flow, HistoryRecord } from '@agenfk/core';

let __server: import('http').Server;
const agent = () => request(__server);
let projectId: string;
let flowId: string;

const flow = (name: string): Flow => ({
  id: `fa-${Math.random().toString(36).slice(2)}`,
  name,
  steps: [
    { id: 's1', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 's2', name: 'IN_PROGRESS', label: 'In Progress', order: 1 },
    { id: 's3', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const hist = (from: string, to: string, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id: Math.random().toString(36).slice(2),
  fromStatus: from as HistoryRecord['fromStatus'],
  toStatus: to as HistoryRecord['toStatus'],
  timestamp: new Date(),
  ...extra,
});

beforeAll(async () => {
  await initStorage();
  __server = app.listen(0);

  const f = flow('Adherence Flow');
  await storage.createFlow(f);
  flowId = f.id;
  const p: any = await storage.createProject({
    id: 'fa-proj',
    name: 'FA',
    flowId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  projectId = p.id;

  // Two items: one fully stamped and consistent, one legacy-unstamped.
  await storage.createItem({
    id: 'fa-item-stamped',
    projectId,
    type: 'TASK',
    title: 'stamped',
    status: 'DONE',
    createdAt: new Date(),
    updatedAt: new Date(),
    history: [
      hist('TODO', 'IN_PROGRESS', { flowId, flowRevision: 1 }),
      hist('IN_PROGRESS', 'DONE', { flowId, flowRevision: 1 }),
    ],
  } as any);
  await storage.createItem({
    id: 'fa-item-legacy',
    projectId,
    type: 'TASK',
    title: 'legacy',
    status: 'DONE',
    createdAt: new Date(),
    updatedAt: new Date(),
    history: [hist('TODO', 'GHOST_STEP')], // no stamp: must not be judged
  } as any);
});

afterAll(async () => {
  await new Promise<void>((r) => __server.close(() => r()));
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('flow adherence endpoints', () => {
  it('per-item: scores only stamped events', async () => {
    const res = await agent().get('/items/fa-item-stamped/flow-adherence');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ judged: 3, compliant: 3, unresolved: 0, unstamped: 0 });
    expect(res.body.score).toBe(1);
  });

  it('per-item: legacy unstamped events are excluded, not counted as failures', async () => {
    const res = await agent().get('/items/fa-item-legacy/flow-adherence');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ judged: 1, unstamped: 1, score: 1 }); // create-stamp judged; legacy GHOST event excluded
  });

  it('per-project: aggregates per item and overall, from stamped events only', async () => {
    const res = await agent().get(`/projects/${projectId}/flow-adherence`);
    expect(res.status).toBe(200);
    expect(res.body.judged).toBe(4);
    expect(res.body.compliant).toBe(4);
    expect(res.body.score).toBe(1);
    expect(res.body.perItem['fa-item-stamped'].judged).toBe(3);
    expect(res.body.perItem['fa-item-legacy'].unstamped).toBe(1);
  });

  it('404s for an unknown item', async () => {
    expect((await agent().get('/items/nope/flow-adherence')).status).toBe(404);
  });

  it('404s for an unknown project', async () => {
    expect((await agent().get('/projects/nope/flow-adherence')).status).toBe(404);
  });

  it('judges an event stamped under the project\'s FORMER flow against that flow\'s own revisions', async () => {
    // A second flow, created but never bound to the project: its revision 1
    // has no GHOST_STEP, so an event into it under the former flow id stays
    // non-compliant — but resolvable, not 'unresolved'.
    const oldFlow = flow('Former Flow');
    await storage.createFlow(oldFlow);
    await storage.createItem({
      id: 'fa-item-switched',
      projectId,
      type: 'TASK',
      title: 'switched',
      status: 'IN_PROGRESS',
      createdAt: new Date(),
      updatedAt: new Date(),
      history: [hist('TODO', 'GHOST_STEP', { flowId: oldFlow.id, flowRevision: 1 })],
    } as any);
    const res = await agent().get('/items/fa-item-switched/flow-adherence');
    expect(res.status).toBe(200);
    // judged 2: the create-stamp (project's flow, compliant) + the former-flow event (non-compliant).
    expect(res.body).toMatchObject({ judged: 2, compliant: 1, unresolved: 0, score: 0.5 });
  });
});
