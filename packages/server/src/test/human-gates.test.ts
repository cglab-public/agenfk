/**
 * @file CGLAB-382 (S6-T1) — human gates: a step can require a person's
 * approval, and a person can pass a blocked check with a written reason.
 *
 * Both are made from the board, never by the agent: the endpoints take the
 * board's header and refuse a request that carries the agent's internal token.
 * (The header is forgeable by a same-user process; real authority is
 * CGLAB-383.) Both are stored as server-written step records, so PUT cannot
 * forge one and a rollback over the step drops them like any other record.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./human-gates-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { TDD_FLOW_PRESET } from '@agenfk/core';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const board = () => ({ 'x-agenfk-ui': '1' });

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-human-gates-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
/** start -> plan (needs a person's go-ahead) -> work (needs a JIRA key) -> end. */
const gatedFlow = () => [
  s('START', 0, { isAnchor: true }),
  s('PLAN', 1, { role: 'planning', checks: [{ id: 'human-approval' }] }),
  s('WORK', 2, { role: 'planning', checks: [{ id: 'jira-key-valid' }] }),
  s('END', 3, { isAnchor: true }),
];

async function setup(status: string, extra: Record<string, unknown> = {}, steps = gatedFlow()) {
  const f = await agent().post('/flows').send({ name: `gates-${++seq}`, steps });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `gates-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: makeRepo(), verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `gates-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const approve = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = board()) =>
  agent().post(`/items/${id}/approvals`).set(headers).send(body);
const override = (id: string, body: Record<string, unknown>, headers: Record<string, string> = board()) =>
  agent().post(`/items/${id}/overrides`).set(headers).send(body);
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;
const byId = (checks: any[], id: string) => (checks ?? []).find((c: any) => c.id === id);

describe('CGLAB-382: human approval', () => {
  it('a step that needs approval refuses to advance until a person approves, and says where to approve', async () => {
    const id = await setup('PLAN');
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(byId(res.body.checks, 'human-approval')).toMatchObject({ outcome: 'fail', blocking: true });
    expect(res.body.message).toMatch(new RegExp(`agenfk ui --open ${id}`));
    expect((await item(id)).status).toBe('PLAN');
  });

  it('once approved from the board, the card advances', async () => {
    const id = await setup('PLAN');
    const a = await approve(id, { note: 'go ahead' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await item(id)).status).toBe('WORK');
    expect(byId((await item(id)).stepRecords.find((r: any) => r.kind === 'exit' && r.step === 'PLAN').checks, 'human-approval'))
      .toMatchObject({ outcome: 'pass' });
  });

  it('refuses an approval without the board header', async () => {
    const id = await setup('PLAN');
    expect((await approve(id, {}, {})).status).toBe(403);
    expect((await validate(id)).status).toBe(422);
  });

  it("refuses an approval carrying the agent's internal token, even with the board header", async () => {
    const id = await setup('PLAN');
    expect((await approve(id, {}, { ...board(), ...internal() })).status).toBe(403);
    expect((await validate(id)).status).toBe(422);
  });

  it('refuses an approval for a step that does not ask for one', async () => {
    const id = await setup('WORK');
    const res = await approve(id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not ask for an approval/);
  });

  it('refuses an approval of a step the card is no longer on (a stale board)', async () => {
    const id = await setup('PLAN');
    const res = await approve(id, { step: 'WORK' });
    expect(res.status).toBe(409);
  });

  it('cannot be forged through PUT /items', async () => {
    const id = await setup('PLAN');
    await agent().put(`/items/${id}`).set(board()).send({ stepRecords: [{ step: 'PLAN', kind: 'approval', at: new Date().toISOString() }] });
    expect((await validate(id)).status).toBe(422);
  });

  it('a rollback over the step drops the approval: re-entering needs a new one', async () => {
    const id = await setup('PLAN', { externalId: 'ABC-1' });
    expect((await approve(id)).status).toBe(201);
    expect((await validate(id)).status).toBe(200);
    const back = await agent().put(`/items/${id}`).send({ status: 'PLAN' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(byId(res.body.checks, 'human-approval')).toMatchObject({ outcome: 'fail' });
  });

  it("one step's approval does not carry over to the next step that asks for one", async () => {
    const twice = gatedFlow();
    (twice[2] as any).checks = [{ id: 'human-approval' }];
    const id = await setup('PLAN', {}, twice);
    expect((await approve(id)).status).toBe(201);
    expect((await validate(id)).status).toBe(200);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(byId(res.body.checks, 'human-approval')).toMatchObject({ outcome: 'fail' });
  });

  it('the shipped TDD flow asks for a go-ahead in its discovery step', () => {
    const discovery = TDD_FLOW_PRESET.steps.find(st => st.name === 'DISCOVERY') as any;
    expect(discovery.checks.map((c: any) => c.id)).toContain('human-approval');
  });
});

describe('CGLAB-382: override with a reason', () => {
  const blocked = async () => {
    const id = await setup('WORK');
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(byId(res.body.checks, 'jira-key-valid')).toMatchObject({ outcome: 'fail', blocking: true });
    return id;
  };

  it('a person passes a blocked check with a written reason, and the card advances', async () => {
    const id = await blocked();
    const o = await override(id, { checkId: 'jira-key-valid', reason: 'spike card, no JIRA issue by design' });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const exit = (await item(id)).stepRecords.find((r: any) => r.kind === 'exit' && r.step === 'WORK');
    const result = byId(exit.checks, 'jira-key-valid');
    expect(result).toMatchObject({ outcome: 'fail', blocking: false });
    expect(result.overridden).toMatchObject({ reason: 'spike card, no JIRA issue by design' });
  });

  it('the override is an event on the card: a comment names the check and the reason', async () => {
    const id = await blocked();
    await override(id, { checkId: 'jira-key-valid', reason: 'spike card, no JIRA issue by design' });
    const comments = (await item(id)).comments.map((c: any) => c.content).join('\n');
    expect(comments).toMatch(/overrid/i);
    expect(comments).toMatch(/jira-key-valid/);
    expect(comments).toMatch(/spike card, no JIRA issue by design/);
  });

  it('refuses an override without a reason', async () => {
    const id = await blocked();
    expect((await override(id, { checkId: 'jira-key-valid' })).status).toBe(400);
    expect((await override(id, { checkId: 'jira-key-valid', reason: '   ' })).status).toBe(400);
    expect((await validate(id)).status).toBe(422);
  });

  it("refuses an override from the agent's channel", async () => {
    const id = await blocked();
    expect((await override(id, { checkId: 'jira-key-valid', reason: 'the agent says so' }, internal())).status).toBe(403);
    expect((await override(id, { checkId: 'jira-key-valid', reason: 'the agent says so' }, { ...board(), ...internal() })).status).toBe(403);
    expect((await validate(id)).status).toBe(422);
  });

  it('refuses an override of a check the step does not run', async () => {
    const id = await blocked();
    const res = await override(id, { checkId: 'suite-green', reason: 'not this step' });
    expect(res.status).toBe(400);
  });

  it('refuses an override of a check that is not blocking the card', async () => {
    const id = await setup('WORK', { externalId: 'ABC-2' });
    const res = await override(id, { checkId: 'jira-key-valid', reason: 'nothing to override' });
    expect(res.status).toBe(409);
  });

  it('an override covers only the check it names', async () => {
    const id = await setup('PLAN');
    await validate(id);
    const res = await override(id, { checkId: 'on-card-branch', reason: 'wrong check' });
    expect(res.status).toBe(409);
    expect((await validate(id)).status).toBe(422);
  });
});

describe('CGLAB-382: GET /items/:id/gates (what the board shows)', () => {
  const gates = async (id: string) => (await agent().get(`/items/${id}/gates`)).body;

  it('says whether the current step waits for a go-ahead, and records it once given', async () => {
    const id = await setup('PLAN');
    expect(await gates(id)).toMatchObject({ step: 'PLAN', approvalRequired: true, approvals: [] });
    await approve(id, { note: 'go' });
    const g = await gates(id);
    expect(g.approvals).toHaveLength(1);
    expect(g.approvals[0]).toMatchObject({ note: 'go', by: 'board' });
  });

  it("carries the last verify's checks for the current step, and each override", async () => {
    const id = await setup('WORK');
    await validate(id);
    let g = await gates(id);
    expect(g.approvalRequired).toBe(false);
    expect(byId(g.lastChecks.results, 'jira-key-valid')).toMatchObject({ blocking: true });
    await override(id, { checkId: 'jira-key-valid', reason: 'spike card, no JIRA issue' });
    g = await gates(id);
    expect(g.overrides['jira-key-valid']).toMatchObject({ reason: 'spike card, no JIRA issue' });
  });

  it("does not show a previous step's checks as the current step's", async () => {
    const id = await setup('PLAN');
    await validate(id);
    await approve(id);
    await validate(id);
    const g = await gates(id);
    expect(g.step).toBe('WORK');
    expect(g.lastChecks).toBeNull();
  });

  it('404s for a card that does not exist', async () => {
    expect((await agent().get('/items/nope/gates')).status).toBe(404);
  });
});
