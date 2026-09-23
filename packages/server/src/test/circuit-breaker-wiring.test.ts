/**
 * @vitest-environment node
 *
 * The circuit breaker has to read a count from somewhere (CGLAB-202, BUG 759b606c).
 *
 * `recordFailure`/`clearFailures` shipped tested and green and wired to
 * nothing: no item carried a count, so `FleetInputs.failures` was never
 * filled and the `circuit-broken` hold was unreachable in the app. These tests
 * pin the producer.
 *
 * WHICH EVENT COUNTS (decision A): a run ending `failed` increments the card's
 * count; a run ending `done` does NOT clear it - the hook closes runs `done` on
 * SessionEnd even when the attempt did not actually succeed, so `done` is not
 * evidence of a good attempt. The card reaching DONE clears, because that is
 * the one event that means the work landed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN, storage } from '../server';

const TEST_DB = path.resolve('./circuit-breaker-wiring-test-db.sqlite');

let __server: import('http').Server;
const agent = () => request(__server);

/*
 * FILE scope, not describe scope. Vitest only runs a suite's `beforeAll` when
 * one of ITS tests runs, so a filtered run (`-t`, which CLAUDE.md documents)
 * of the second describe would skip the first describe's hook entirely -
 * leaving AGENFK_DB_PATH unset and writing this test's project, flow and items
 * into the developer's real database. The env var and the server belong to the
 * file, and so does the cleanup.
 */
beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  __server = app.listen(0);
  await initStorage();
});
afterAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await new Promise<void>(r => __server.close(() => r()));
});

const internal = (req: request.Test) => req.set('x-agenfk-internal', VERIFY_TOKEN!);

describe('the breaker reads a persisted count', () => {
  let projectId: string;

  beforeEach(async () => {
    await initStorage();
    const p = await internal(agent().post('/projects')).send({ name: 'breaker' });
    projectId = p.body.id;
  });

  const makeItem = async () => {
    const res = await internal(agent().post('/items')).send({ type: 'TASK', title: 'probe', projectId });
    return res.body.id as string;
  };
  const startRun = async (itemId: string) =>
    (await internal(agent().post('/agent-runs')).send({ itemId, step: 'IN_PROGRESS' })).body.id as string;
  const countOf = async (itemId: string) =>
    (await agent().get(`/items/${itemId}`)).body.failureCount as number | undefined;

  it('a failed run counts against the card', async () => {
    const item = await makeItem();
    const run = await startRun(item);
    await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    expect(await countOf(item)).toBe(1);
  });

  it('repeats of the same failure add up, three deep', async () => {
    // Consecutive is the whole meaning. A count that stops at one cannot reach
    // the threshold, and the breaker never opens.
    const item = await makeItem();
    for (let i = 0; i < 3; i++) {
      const run = await startRun(item);
      await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    }
    expect(await countOf(item)).toBe(3);
  });

  it('a run finishing done does NOT clear the count', async () => {
    // `done` is SessionEnd, not success. Clearing on it lets the breaker reset
    // itself between attempts that all failed, which is the decoration the
    // module warns against.
    const item = await makeItem();
    const failed = await startRun(item);
    await internal(agent().patch(`/agent-runs/${failed}`)).send({ status: 'failed' });

    const finished = await startRun(item);
    await internal(agent().patch(`/agent-runs/${finished}`)).send({ status: 'done' });

    expect(await countOf(item)).toBe(1);
  });

  it('re-sending failed for the same run does not count twice', async () => {
    const item = await makeItem();
    const run = await startRun(item);
    await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    expect(await countOf(item)).toBe(1);
  });

  /*
   * The clear-on-DONE lives at `storage.updateItem`, which every path to DONE
   * routes through (validate_progress, its sibling propagation, an internal
   * PUT). It is pinned in storage-sqlite's crud.test.ts rather than here, and
   * deliberately so: a PUT cannot reach DONE directly - the flow refuses
   * TODO -> DONE - so a route-level test of it would be driving a transition
   * the product does not allow.
   */

  it('a client cannot reset its own breaker through the item route', async () => {
    // The count is the server's, like endedAt. Letting a PUT set it would make
    // the limit something the limited party can lift.
    const item = await makeItem();
    const run = await startRun(item);
    await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });

    await internal(agent().put(`/items/${item}`)).send({ failureCount: 0 });
    expect(await countOf(item)).toBe(1);
  });

  it('a run that dies without ever being closed counts for nothing, but must not throw', async () => {
    // Reachable: deleteItem removes the item and its terminals but not its
    // runs, so an orphaned run can still be PATCHed failed.
    const run = (await internal(agent().post('/agent-runs')).send({ itemId: 'deleted-card', step: 's' })).body.id;
    const res = await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    expect(res.status).toBe(200);
  });
});

/**
 * The exit step of a custom flow is rarely named DONE (`agnfk flow create`
 * makes its own). A clear keyed on the literal word would leave the count at
 * three forever on every one of those flows - the breaker permanently open on
 * a card that finished, with no supported route to reset it.
 */
describe('the breaker clears on a flow whose exit is not named DONE', () => {
  let projectId: string;

  beforeEach(async () => {
    await initStorage();
    const p = await internal(agent().post('/projects')).send({ name: 'shipped-flow' });
    projectId = p.body.id;
    const f = await internal(agent().post('/flows')).send({
      name: 'Ship Flow',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'SPEC', label: 'Spec', order: 1 },
        { name: 'CODE', label: 'Code', order: 2 },
        { name: 'SHIPPED', label: 'Shipped', order: 3, isAnchor: true },
      ],
    });
    await internal(agent().post(`/projects/${projectId}/flow`)).send({ flowId: f.body.id });
  });

  it('clears when the card lands on its own exit step', async () => {
    const item = (await internal(agent().post('/items')).send({ type: 'TASK', title: 'ship', projectId })).body.id;
    for (let i = 0; i < 3; i++) {
      const run = (await internal(agent().post('/agent-runs')).send({ itemId: item, step: 'IN_PROGRESS' })).body.id;
      await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    }
    expect((await agent().get(`/items/${item}`)).body.failureCount).toBe(3);

    await storage.updateItem(item, { status: 'SPEC' } as any);
    await storage.updateItem(item, { status: 'CODE' } as any);
    const res = await internal(agent().post(`/items/${item}/validate`)).send({ evidence: 'done', command: 'true' });
    expect(res.status).toBe(200);

    // The storage clear keyed on the literal DONE cannot fire here; only the
    // flow-aware one can.
    expect((await agent().get(`/items/${item}`)).body.failureCount).toBe(0);
  });

  it('does NOT clear when the card only parks on a mid-flow special step', async () => {
    /*
     * `isFinalStep` is "any boundary step", which is right for requiring a
     * command and wrong for a clear: a flow may hold at a special step in the
     * middle. Clearing there would hand a card that is one failure from the
     * open breaker a clean slate just for being parked.
     */
    const p = await internal(agent().post('/projects')).send({ name: 'hold-flow' });
    const proj = p.body.id;
    const f = await internal(agent().post('/flows')).send({
      name: 'Hold Flow',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'SPEC', label: 'Spec', order: 1 },
        { name: 'HOLD', label: 'Hold', order: 2, isSpecial: true },
        { name: 'CODE', label: 'Code', order: 3 },
        { name: 'SHIPPED', label: 'Shipped', order: 4, isAnchor: true },
      ],
    });
    await internal(agent().post(`/projects/${proj}/flow`)).send({ flowId: f.body.id });

    const item = (await internal(agent().post('/items')).send({ type: 'TASK', title: 'parked', projectId: proj })).body.id;
    for (let i = 0; i < 2; i++) {
      const run = (await internal(agent().post('/agent-runs')).send({ itemId: item, step: 'IN_PROGRESS' })).body.id;
      await internal(agent().patch(`/agent-runs/${run}`)).send({ status: 'failed' });
    }
    expect((await agent().get(`/items/${item}`)).body.failureCount).toBe(2);

    await storage.updateItem(item, { status: 'SPEC' } as any);
    // SPEC -> HOLD is a boundary step, so a command is required and it passes.
    const res = await internal(agent().post(`/items/${item}/validate`)).send({ evidence: 'parked', command: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HOLD');
    // Parked is not done: one failure from the breaker must survive.
    expect((await agent().get(`/items/${item}`)).body.failureCount).toBe(2);
  });
});
