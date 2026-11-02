/**
 * Regression tests for: MCP tool schemas hardcode default-flow status enum.
 *
 * Bug: list_items / update_item / create_item declared `status` with a fixed
 * enum (TODO|IN_PROGRESS|TEST|REVIEW|DONE|BLOCKED|PAUSED) in both the JSON
 * Schema (tool definition) and the Zod parser. Items in custom-flow steps
 * (e.g. DISCOVERY, CREATE_UNIT_TESTS) were rejected. list_items also required
 * `status`, so there was no "everything in flight" sweep.
 *
 * This file pins the REST side: GET /items accepts custom statuses and returns
 * items regardless of step name. The MCP tools themselves are driven through a
 * real MCP client in mcp-item-tools-custom-status.test.ts.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage, closeStorage } from '../server';

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


const TEST_DB = testDbPath('mcp-status-enum-custom-flows-test-db.sqlite');

// ── REST functional tests ─────────────────────────────────────────────────────
// These verify the underlying API behaviour the MCP tools delegate to.

describe('GET /items supports custom-flow statuses', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await removeTestDb(TEST_DB, closeStorage);
    await initStorage();
  });

  afterAll(async () => {
    await removeTestDb(TEST_DB, closeStorage);
  });

  it('returns items parked in custom-flow steps (e.g. DISCOVERY)', async () => {
    // Set up: project + custom flow with DISCOVERY step + item parked there.
    const project = (await agent().post('/projects').send({ name: 'CustomFlowProj' })).body;
    const flow = (await agent().post('/flows').send({
      name: 'TDD',
      steps: [
        { id: 'a', name: 'TODO', order: 1, isAnchor: true },
        { id: 'b', name: 'DISCOVERY', order: 2, exitCriteria: 'Scope clear' },
        { id: 'c', name: 'DONE', order: 3, isAnchor: true },
      ],
    })).body;
    await agent().post(`/projects/${project.id}/flow`).send({ flowId: flow.id });

    const item = (await agent().post('/items').send({
      projectId: project.id,
      type: 'TASK',
      title: 'In discovery',
      status: 'DISCOVERY',
    })).body;
    expect(item.status).toBe('DISCOVERY');

    // The "no status filter" sweep returns all in-flight items including custom statuses.
    const allRes = await agent().get(`/items`).query({ projectId: project.id });
    expect(allRes.status).toBe(200);
    expect(allRes.body.find((i: any) => i.id === item.id)).toBeTruthy();

    // Filtering by the custom status should also return it.
    const filteredRes = await agent().get(`/items`).query({ projectId: project.id, status: 'DISCOVERY' });
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.body.some((i: any) => i.id === item.id)).toBe(true);
  });
});
