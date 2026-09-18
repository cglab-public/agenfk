/**
 * @file CGLAB-275 — a failed verify command REFUSES the advance; it does not
 * move the card anywhere.
 *
 * Observed on a TDD flow (TODO → DISCOVERY → CREATE_UNIT_TESTS → IN_PROGRESS →
 * REFACTOR → REVIEW → DONE) driven by a pi agent: the agent wrote red tests on
 * CREATE_UNIT_TESTS — exactly what that step's criteria ask for — and passed
 * pytest as the verify command. The suite exited non-zero, and the server
 * rolled the card back to the flow's first non-anchor step, which on that flow
 * is DISCOVERY. Two steps backwards, for doing the step right. The failure
 * response did not say where the card had gone; the agent found out with a
 * separate `agenfk get`.
 *
 * The rollback was computed by POSITION (first non-anchor step) and fired
 * regardless of what the step's criteria said. The server cannot evaluate
 * prose criteria, so the exit code of an optional command is not evidence the
 * criteria failed. The one place the server DOES know is the final step: its
 * command is the project's suite, and a red suite must not land DONE.
 *
 * Contract under test:
 *  - intermediate step, command exits non-zero → 422, the item's status is
 *    UNCHANGED, and the response body and message both name that status;
 *  - final step, command exits non-zero → 422, the item stays ON the final
 *    step (not DONE, not the coding step) — the hard gate is a refusal, not a
 *    demotion;
 *  - final step, command exits zero → DONE (the gate still opens);
 *  - the async run reports the unchanged status as `itemStatus`;
 *  - the ValidateTool comment records the refusal on the step it happened,
 *    never a transition to some other step;
 *  - an intermediate step with no command still advances without running
 *    anything (unchanged behaviour, pinned so the fix does not overreach).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./verify-refuse-not-rollback-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Import AFTER the env var so storage lands in the test DB.
import { app, initStorage, VERIFY_TOKEN } from '../server';

// One listening server for the file (BUG 9de0c99c): per-call ephemeral servers
// churn sockets and surface as confident wrong assertions elsewhere.
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/** The shape of the flow the bug was observed on, trimmed to what matters. */
const TDD_STEPS = [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'DISCOVERY', label: 'Discovery', order: 1, exitCriteria: 'Ask, then get the go-ahead.' },
  { name: 'CREATE_UNIT_TESTS', label: 'Unit Tests', order: 2, exitCriteria: 'Tests written; they can all fail at this point.' },
  { name: 'IN_PROGRESS', label: 'In Progress', order: 3, exitCriteria: 'All tests passing.' },
  { name: 'DONE', label: 'Done', order: 4, isAnchor: true },
];

/** Project on the TDD flow with a TASK parked on `status`. Every request is checked. */
async function itemOnTddStep(name: string, status: string, verifyCommand?: string) {
  const project = await agent().post('/projects').send({ name });
  expect(project.status, `project: ${JSON.stringify(project.body)}`).toBe(201);
  const projectId = project.body.id;

  const flow = await agent().post('/flows').set(internal()).send({ name: `${name}-tdd`, steps: TDD_STEPS });
  expect(flow.status, `flow: ${JSON.stringify(flow.body)}`).toBe(201);
  const use = await agent().post(`/projects/${projectId}/flow`).set(internal()).send({ flowId: flow.body.id });
  expect(use.status, `use flow: ${JSON.stringify(use.body)}`).toBe(200);

  if (verifyCommand) {
    const cmd = await agent().put(`/projects/${projectId}/verify-command`).set(internal()).send({ verifyCommand });
    expect(cmd.status, `verify-command: ${JSON.stringify(cmd.body)}`).toBe(200);
  }

  const created = await agent().post('/items').send({ type: 'TASK', title: `${name}-item`, projectId });
  expect(created.status, `item: ${JSON.stringify(created.body)}`).toBe(201);
  const moved = await agent().post('/items/bulk').set(internal())
    .send({ items: [{ id: created.body.id, updates: { status } }] });
  expect(moved.status, `move: ${JSON.stringify(moved.body)}`).toBe(200);

  const readBack = await agent().get(`/items/${created.body.id}`);
  expect(readBack.body.status, `the item is not on ${status}`).toBe(status);
  return { projectId, item: readBack.body };
}

/** Default-flow project with a TASK on TEST (the final step) and a verifyCommand. */
async function itemOnDefaultFinalStep(name: string, verifyCommand: string) {
  const project = await agent().post('/projects').send({ name });
  expect(project.status).toBe(201);
  const cmd = await agent().put(`/projects/${project.body.id}/verify-command`).set(internal()).send({ verifyCommand });
  expect(cmd.status).toBe(200);
  const created = await agent().post('/items').send({ type: 'TASK', title: `${name}-item`, projectId: project.body.id });
  expect(created.status).toBe(201);
  const moved = await agent().post('/items/bulk').set(internal())
    .send({ items: [{ id: created.body.id, updates: { status: 'TEST' } }] });
  expect(moved.status).toBe(200);
  const readBack = await agent().get(`/items/${created.body.id}`);
  expect(readBack.body.status).toBe('TEST');
  return readBack.body;
}

async function waitForRun(runId: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await agent().get(`/items/validate-runs/${runId}`).set(internal());
    if (res.status !== 200 || res.body.status !== 'running' || Date.now() - start > timeoutMs) return res;
    await new Promise(r => setTimeout(r, 100));
  }
}

const validateComments = (item: any) =>
  (item.comments || []).filter((c: any) => c.author === 'ValidateTool').map((c: any) => String(c.content));

describe('POST /items/:id/validate — a failed command refuses, it does not roll back (CGLAB-275)', () => {
  beforeEach(async () => { await initStorage(); });

  it('leaves the card on the intermediate step it was on when the command fails', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await itemOnTddStep('RNR1', 'CREATE_UNIT_TESTS');

    const res = await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'red tests written, as the step asks', command: 'echo 32 failed && exit 1' });

    expect(res.status).toBe(422);
    // The body names the status the card is now on — which is where it was.
    expect(res.body.status).toBe('CREATE_UNIT_TESTS');

    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('CREATE_UNIT_TESTS');
    expect(after.status).not.toBe('DISCOVERY');
  });

  it('says in the failure message where the card is, so the agent need not go and look', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await itemOnTddStep('RNR2', 'CREATE_UNIT_TESTS');

    const res = await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'red tests', command: 'exit 1' });

    expect(res.status).toBe(422);
    const msg: string = res.body.message;
    expect(msg).toMatch(/Validation Failed/);
    // The resulting status is stated, and stated as unchanged.
    expect(msg).toMatch(/Item (stays|remains) on CREATE_UNIT_TESTS/);
  });

  it('records the refusal on the step it happened, not a transition to another step', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await itemOnTddStep('RNR3', 'CREATE_UNIT_TESTS');

    await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'red tests', command: 'exit 1' });

    const after = (await agent().get(`/items/${item.id}`)).body;
    const failed = validateComments(after).filter((c: string) => c.includes('FAILED'));
    expect(failed.length).toBe(1);
    // The old comment read "**Step**: CREATE_UNIT_TESTS → DISCOVERY". The card
    // did not go anywhere, so the comment must not claim it did.
    expect(failed[0]).not.toContain('→ DISCOVERY');
    expect(failed[0]).not.toContain('→ IN_PROGRESS');
    expect(failed[0]).toContain('CREATE_UNIT_TESTS');
  });

  it('keeps the final-step hard gate: a red suite does not land DONE, and the card stays on the final step', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnDefaultFinalStep('RNR4', 'echo suite red && exit 1');

    const res = await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'claiming green' });

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('TEST');
    expect(res.body.message).toMatch(/Item (stays|remains) on TEST/);

    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('TEST');
    expect(after.status).not.toBe('DONE');
    expect(after.status).not.toBe('IN_PROGRESS');
    // The FAILED test record is still logged on the final step.
    expect((after.tests || []).some((t: any) => t.status === 'FAILED')).toBe(true);
  });

  it('records the FAILED test on a red final gate even when the exit step is not named DONE', async () => {
    // The failure path used to key the FAILED record on the literal name DONE
    // while the success path used the positional "next step ends the flow"
    // predicate. On a CLI-authored flow whose exit step is SHIPPED, a red gate
    // therefore left no record at all. The code may assume a first anchor,
    // ordered steps and a last anchor — never a step's name.
    if (!VERIFY_TOKEN) return;
    const project = await agent().post('/projects').send({ name: 'RNR10' });
    expect(project.status).toBe(201);
    const projectId = project.body.id;
    const flow = await agent().post('/flows').set(internal()).send({ name: 'RNR10-cli', steps: [
      { name: 'BACKLOG', label: 'Backlog', order: 0, isAnchor: true },
      { name: 'CHECKING', label: 'Checking', order: 1 },
      { name: 'SHIPPED', label: 'Shipped', order: 2, isAnchor: true },
    ] });
    expect(flow.status, JSON.stringify(flow.body)).toBe(201);
    expect((await agent().post(`/projects/${projectId}/flow`).set(internal()).send({ flowId: flow.body.id })).status).toBe(200);
    expect((await agent().put(`/projects/${projectId}/verify-command`).set(internal()).send({ verifyCommand: 'exit 1' })).status).toBe(200);
    const created = await agent().post('/items').send({ type: 'TASK', title: 'RNR10-item', projectId });
    expect(created.status).toBe(201);
    expect((await agent().post('/items/bulk').set(internal()).send({ items: [{ id: created.body.id, updates: { status: 'CHECKING' } }] })).status).toBe(200);

    const res = await agent().post(`/items/${created.body.id}/validate`).set(internal()).send({ evidence: 'claiming green' });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('CHECKING');

    const after = (await agent().get(`/items/${created.body.id}`)).body;
    expect(after.status).toBe('CHECKING');
    expect((after.tests || []).filter((t: any) => t.status === 'FAILED').length).toBe(1);
  });

  it('still opens the final gate when the suite is green', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnDefaultFinalStep('RNR5', 'echo suite green');

    const res = await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'green' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DONE');
    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('DONE');
  });

  it('reports the unchanged status as itemStatus on a failed async run', async () => {
    if (!VERIFY_TOKEN) return;
    const item = await itemOnDefaultFinalStep('RNR6', 'echo async-red && exit 3');

    const res = await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'claiming green', async: true });
    expect(res.status).toBe(202);

    const done = await waitForRun(res.body.runId);
    expect(done.body.status).toBe('failed');
    expect(done.body.itemStatus).toBe('TEST');

    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('TEST');
  });

  it('ends every response with the resulting status, so a `| tail` still shows where the card is', async () => {
    // The pi agent piped verify through `tail -8`. The transition line sits at
    // the TOP of the message and the next step's criteria banner pushed it out
    // of view, so a successful advance read as "still on the same step" and a
    // silent rollback read as nothing at all. The last line must always say
    // where the card is now.
    if (!VERIFY_TOKEN) return;
    const { item: red } = await itemOnTddStep('RNR9a', 'CREATE_UNIT_TESTS');
    const failed = await agent().post(`/items/${red.id}/validate`).set(internal())
      .send({ evidence: 'red tests', command: 'exit 1' });
    expect(failed.status).toBe(422);
    expect(String(failed.body.message).trim().split('\n').pop()).toMatch(/^The advance was refused\. Item stays on CREATE_UNIT_TESTS\.$/);

    const { item: green } = await itemOnTddStep('RNR9b', 'CREATE_UNIT_TESTS');
    const passed = await agent().post(`/items/${green.id}/validate`).set(internal())
      .send({ evidence: 'red tests written' });
    expect(passed.status).toBe(200);
    expect(String(passed.body.message).trim().split('\n').pop()).toMatch(/Item is now on IN_PROGRESS/);
  });

  it('an intermediate step with no command still advances without running anything (unchanged)', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await itemOnTddStep('RNR8', 'CREATE_UNIT_TESTS');

    const res = await agent().post(`/items/${item.id}/validate`).set(internal())
      .send({ evidence: 'red tests written; no command on a red step' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
    const after = (await agent().get(`/items/${item.id}`)).body;
    expect(after.status).toBe('IN_PROGRESS');
  });
});
