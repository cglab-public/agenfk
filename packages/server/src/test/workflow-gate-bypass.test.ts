/**
 * CGLAB-81 — the workflow gate must not be bypassable.
 *
 * The framework's central guarantee is that an item only moves forward through
 * `validate_progress`, which records evidence and evaluates the step's exit
 * criteria. Four routes defeated that. These drive the real Express app so they
 * fail if the guarantee regresses, rather than asserting on source text.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import { app, initStorage, closeStorage, buildAllowedTransitions } from '../server';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call —
 * 12 of them here. The churn produced `Error: Parse Error: Expected HTTP/`,
 * a transport failure that hands the test an empty body, so the next call goes
 * to `/items/undefined` and one bad socket surfaces as a confident wrong
 * assertion in whichever test was running.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


const TEST_DB = testDbPath('workflow-gate-bypass-test-db.sqlite');

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
    await removeTestDb(TEST_DB, closeStorage);
    await initStorage();
  });
  afterAll(async () => { await removeTestDb(TEST_DB, closeStorage); });
  beforeEach(async () => {
    await initStorage();
    const p = await agent().post('/projects').send({ name: 'gate-test' });
    projectId = p.body.id;
  });

  const newItem = async () => {
    const r = await agent().post('/items').send({ type: 'TASK', title: 'gate', projectId });
    return r.body.id;
  };

  it('rejects a multi-step forward jump on a project with NO custom flow', async () => {
    // The check used to run only `if (projectFlowId)`, so default-flow projects
    // — the majority — got no validation at all.
    const id = await newItem();
    const res = await agent().put(`/items/${id}`).send({ status: 'TEST' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/FLOW VIOLATION/i);
  });
});
