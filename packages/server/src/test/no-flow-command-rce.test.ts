/**
 * The invariant that keeps a flow from becoming remote code execution.
 *
 * `validate_progress` ends in `spawn(resolvedCommand, { shell: true })`. That is
 * fine while the only sources are the caller's own request and the project's
 * verifyCommand, both local. It becomes RCE the moment a FLOW can supply the
 * command, because flows are installable from a community registry and pushable
 * org-wide from the hub — so their text is not necessarily written by the person
 * being worked for.
 *
 * A CodeQL triage cleared 12 critical command-injection alerts on exactly this
 * reasoning. Nothing enforced it, so it held by accident. These tests make it
 * hold on purpose: they fail the day a step gains a command field, which is
 * precisely when someone should be stopped and made to think.
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


const TEST_DB = path.resolve('./no-flow-command-rce-test-db.sqlite');

describe('a flow cannot supply the verify command', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => { await initStorage(); });

  it('ignores a command smuggled onto a flow step', async () => {
    const marker = path.resolve('./RCE_MARKER_SHOULD_NOT_EXIST');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);

    const p = await agent().post('/projects').send({ name: 'rce-probe' });
    projectId = p.body.id;

    // A hostile flow: every step carries a `command`, as a community-registry or
    // org-pushed flow could if the field were ever honoured.
    const hostile = `touch ${marker}`;
    const f = await agent().post('/flows').send({
      name: 'Hostile Flow',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true, command: hostile, verifyCommand: hostile },
        { name: 'WORK', label: 'Work', order: 1, command: hostile, verifyCommand: hostile },
        { name: 'DONE', label: 'Done', order: 2, isAnchor: true, command: hostile, verifyCommand: hostile },
      ],
    });
    expect(f.status).toBeLessThan(400);
    await agent().post(`/projects/${projectId}/flow`).send({ flowId: f.body.id });

    const item = await agent().post('/items').send({ type: 'TASK', title: 'probe', projectId });
    await agent().put(`/items/${item.body.id}`).send({ status: 'WORK' });

    // Advancing off the final step with no command must fall back to the
    // PROJECT's verifyCommand — which is unset — and refuse. It must never pick
    // the command up off the flow.
    const res = await agent()
      .post(`/items/${item.body.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'probing whether a flow can inject a command' });

    expect(JSON.stringify(res.body)).toMatch(/NO_VERIFY_COMMAND/);
    expect(fs.existsSync(marker), 'a flow step executed its own command — this is RCE').toBe(false);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  });

  it('does not persist a command field onto stored flow steps', async () => {
    const f = await agent().post('/flows').send({
      name: 'Smuggle Probe',
      steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'WORK', label: 'Work', order: 1, command: 'echo pwned', verifyCommand: 'echo pwned' },
        { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
      ],
    });
    const stored = await agent().get(`/flows/${f.body.id}`);
    const serialized = JSON.stringify(stored.body);
    expect(serialized).not.toMatch(/pwned/);
  });
});
