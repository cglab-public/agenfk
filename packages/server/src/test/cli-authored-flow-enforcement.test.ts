/**
 * A flow authored through `agenfk flow create` must get the same enforcement as
 * the shipped default one.
 *
 * The CLI only ever asks "Is this a terminal/special step?" and emits
 * `isSpecial`; it never sets `isAnchor`. `POST /flows` persists the steps
 * verbatim — it injects no TODO/DONE anchors. So a real, first-class,
 * documented path produces flows where every boundary step is marked ONLY with
 * `isSpecial`, and where the exit step is not named `DONE`.
 *
 * Every predicate that asks "is this a real working step" has to agree on such
 * a flow. When the read side (what the gatekeeper reports, what counts as
 * in-flight) and the write side (`validate_progress`) answer differently, the
 * disagreement is not cosmetic — it costs enforcement in both directions:
 *
 *  - the contract names a final step the server does not treat as final, so the
 *    agent omits the verify command and the server advances without running
 *    anything; and
 *  - a failed verify parks the item on a boundary step, which the gatekeeper
 *    then reports as "no active task", mechanically blocking every edit so the
 *    agent cannot fix the failure it was sent back for.
 *
 * Nothing else in the suite drives `validate_progress` over a flow whose exit
 * step is not literally named `DONE`, which is why both survived three reviews.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

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


const TEST_DB = path.resolve('./cli-authored-flow-test-db.sqlite');

/** Exactly what `agenfk flow create` emits: isSpecial only, never isAnchor. */
const CLI_FLOW_STEPS = [
  { name: 'BACKLOG', label: 'Backlog', order: 0, isSpecial: true },
  { name: 'BUILDING', label: 'Building', order: 1 },
  { name: 'CHECKING', label: 'Checking', order: 2 },
  { name: 'SHIPPED', label: 'Shipped', order: 3, isSpecial: true },
];

async function projectOnCliFlow(name: string, verifyCommand?: string): Promise<string> {
  const p = await agent().post('/projects').set('x-agenfk-internal', VERIFY_TOKEN!).send({ name });
  const projectId = p.body.id;
  const f = await agent().post('/flows').set('x-agenfk-internal', VERIFY_TOKEN!).send({ name: `${name}-flow`, steps: CLI_FLOW_STEPS });
  expect(f.status).toBeLessThan(400);
  await agent().post(`/projects/${projectId}/flow`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ flowId: f.body.id });
  if (verifyCommand) {
    // Its own privileged endpoint, not PUT /projects: verifyCommand is a shell
    // string run by validate_progress, so it is deliberately outside the
    // general update allowlist (bug e60e20aa, mass assignment → RCE).
    const set = await agent()
      .put(`/projects/${projectId}/verify-command`)
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ verifyCommand });
    expect(set.status).toBeLessThan(400);
  }
  return projectId;
}

describe('a CLI-authored flow gets the same COMMAND GATE as the default one', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => { await initStorage(); });

  it('refuses to leave the last real step with no command at all', async () => {
    // The gatekeeper contract tells the agent "Final step (omit the command on
    // this one): CHECKING". If the server does not agree that CHECKING is
    // final, it takes the intermediate-step path — "no command, advance without
    // running anything" — and the item reaches the terminal step having run no
    // verification whatsoever. The agent followed the instructions it was
    // given, and the gate silently did not exist.
    const projectId = await projectOnCliFlow('cli-no-verify-cmd');
    const item = await agent().post('/items').set('x-agenfk-internal', VERIFY_TOKEN!).send({ type: 'TASK', title: 'probe', projectId });
    await agent().put(`/items/${item.body.id}`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ status: 'CHECKING' });

    const res = await agent()
      .post(`/items/${item.body.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'done, honest' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_VERIFY_COMMAND');

    const after = await agent().get(`/items/${item.body.id}`);
    expect(after.body.status).toBe('CHECKING');
  });

  it("falls back to the project's verifyCommand on the last real step", async () => {
    // The other half of the same disagreement: with a verifyCommand configured,
    // omitting the command must RUN it, not skip it.
    const projectId = await projectOnCliFlow('cli-with-verify-cmd', 'exit 1');
    const item = await agent().post('/items').set('x-agenfk-internal', VERIFY_TOKEN!).send({ type: 'TASK', title: 'probe', projectId });
    await agent().put(`/items/${item.body.id}`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ status: 'CHECKING' });

    const res = await agent()
      .post(`/items/${item.body.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'claiming success' });

    // The command ran and failed, so the item must NOT have advanced.
    expect(res.status).toBe(422);
    const after = await agent().get(`/items/${item.body.id}`);
    expect(after.body.status).not.toBe('SHIPPED');
  });

  it('never strands an item outside its own flow, even on a degenerate one', async () => {
    // If EVERY step is marked terminal — which `agenfk flow create` permits,
    // it just asks yes/no per step — there is no coding step to roll back to.
    // Falling back to the literal IN_PROGRESS puts the item on a status the
    // flow does not contain, and that is a one-way door: findCurrentFlowStep
    // returns undefined so every later verify 400s, and buildAllowedTransitions
    // takes its currentIdx === -1 recovery branch whose real-step filter is
    // also empty here, so it offers no route back in. The item is stuck with
    // no supported command that can move it.
    const p = await agent().post('/projects').set('x-agenfk-internal', VERIFY_TOKEN!).send({ name: 'degenerate' });
    const projectId = p.body.id;
    const f = await agent().post('/flows').set('x-agenfk-internal', VERIFY_TOKEN!).send({
      name: 'all-terminal',
      steps: [
        { name: 'ONE', label: 'One', order: 0, isSpecial: true },
        { name: 'TWO', label: 'Two', order: 1, isSpecial: true },
      ],
    });
    await agent().post(`/projects/${projectId}/flow`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ flowId: f.body.id });
    await agent().put(`/projects/${projectId}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand: 'exit 1' });

    const item = await agent().post('/items').set('x-agenfk-internal', VERIFY_TOKEN!).send({ type: 'TASK', title: 'probe', projectId });
    await agent().put(`/items/${item.body.id}`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ status: 'ONE' });

    await agent().post(`/items/${item.body.id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'will fail' });

    const after = await agent().get(`/items/${item.body.id}`);
    expect(['ONE', 'TWO']).toContain(after.body.status);
  });

  it('sends a failed verify back to a step the agent is still allowed to work in', async () => {
    // A failed verify rolls the item back to the "coding step". If that is
    // computed with a predicate blind to isSpecial, it lands on BACKLOG — a
    // boundary step — and the gatekeeper then reports no active task and
    // mechanically blocks every Edit. The agent is sent back to fix a failure
    // and simultaneously forbidden from touching the code.
    const projectId = await projectOnCliFlow('cli-failure-rollback', 'exit 1');
    const item = await agent().post('/items').set('x-agenfk-internal', VERIFY_TOKEN!).send({ type: 'TASK', title: 'probe', projectId });
    await agent().put(`/items/${item.body.id}`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ status: 'CHECKING' });

    await agent().post(`/items/${item.body.id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'will fail' });

    const after = await agent().get(`/items/${item.body.id}`);
    expect(after.body.status).not.toBe('BACKLOG');

    // The property that actually matters, stated directly: the item is still
    // something the gatekeeper counts as active work.
    const active = await agent().get('/items').query({ active: 'true', projectId });
    expect(active.body.map((i: { id: string }) => i.id)).toContain(item.body.id);
  });
});
