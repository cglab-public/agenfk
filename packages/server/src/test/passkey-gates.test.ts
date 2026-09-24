/**
 * @file CGLAB-383 (S7-T1) — approvals and overrides signed with a passkey.
 *
 * Signing is a per-step choice: the step's human-approval check carries
 * `signature: none | passkey` (default none), and overrides on that step
 * follow it. On a step that asks for a passkey, a human gate needs a fresh
 * assertion from an enrolled one:
 * a signature over a single-use challenge the server bound to that exact act
 * (card, kind, step, check, reason or note). The board header alone - which
 * any same-user process can send - does not suffice there. Elsewhere the S6
 * behaviour stands, and each act is recorded as unverified.
 *
 * The first passkey is trust-on-first-use; adding or removing one needs an
 * assertion from a passkey already enrolled.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const TEST_DB = path.resolve('./passkey-gates-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-passkeys-'));
const STORE = path.join(STORE_DIR, 'passkeys.json');
process.env.AGENFK_PASSKEY_STORE = STORE;

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { SoftAuthenticator } from './softAuthenticator';

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
  for (const r of [...repos, STORE_DIR]) fs.rmSync(r, { recursive: true, force: true });
});
beforeEach(() => { fs.rmSync(STORE, { force: true }); });

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const board = () => ({ 'x-agenfk-ui': '1' });

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
/** PLAN and WORK sign with a passkey when `signed`; WORK's approval is what makes its overrides follow. */
const gatedFlow = (signed = true) => {
  const approval = { id: 'human-approval', ...(signed ? { params: { signature: 'passkey' } } : {}) };
  return [
    s('START', 0, { isAnchor: true }),
    s('PLAN', 1, { role: 'planning', checks: [approval] }),
    s('WORK', 2, { role: 'planning', checks: [{ id: 'jira-key-valid' }, ...(signed ? [approval] : [])] }),
    s('END', 3, { isAnchor: true }),
  ];
};
async function card(status: string, signed = true) {
  const f = await agent().post('/flows').send({ name: `pk-${++seq}`, steps: gatedFlow(signed) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pk-repo-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `pk-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `pk-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const challenge = async (body: Record<string, unknown>) => {
  const res = await agent().post('/webauthn/challenge').set(board()).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.challenge as string;
};
async function enroll(a = new SoftAuthenticator(), assertion?: unknown) {
  const ch = await challenge({ purpose: 'enroll' });
  return agent().post('/webauthn/credentials').set(board()).send({ registration: a.register(ch), ...(assertion ? { assertion } : {}) });
}
async function signedApproval(a: SoftAuthenticator, id: string, step: string, note?: string) {
  const ch = await challenge({ purpose: 'approval', itemId: id, step, ...(note ? { note } : {}) });
  return a.assert(ch);
}
const approve = (id: string, body: Record<string, unknown>) => agent().post(`/items/${id}/approvals`).set(board()).send(body);
const override = (id: string, body: Record<string, unknown>) => agent().post(`/items/${id}/overrides`).set(board()).send(body);
const item = async (id: string) => (await agent().get(`/items/${id}`)).body;

describe('CGLAB-383: enrolling a passkey', () => {
  it('starts with none enrolled', async () => {
    expect((await agent().get('/webauthn/status')).body).toMatchObject({ enrolled: false, credentials: [] });
  });

  it('enrolls the first passkey on trust, and reports it', async () => {
    const a = new SoftAuthenticator();
    expect((await enroll(a)).status).toBe(201);
    const st = (await agent().get('/webauthn/status')).body;
    expect(st.enrolled).toBe(true);
    expect(st.credentials.map((c: any) => c.id)).toEqual([a.id]);
  });

  it('keeps the store readable by the user only, and never serves the public keys over status', async () => {
    await enroll();
    expect(fs.statSync(STORE).mode & 0o777).toBe(0o600);
    const st = (await agent().get('/webauthn/status')).body;
    expect(JSON.stringify(st)).not.toMatch(/publicKey/);
  });

  it('refuses a second passkey without an assertion from the first', async () => {
    await enroll();
    const res = await enroll(new SoftAuthenticator());
    expect(res.status).toBe(401);
    expect((await agent().get('/webauthn/status')).body.credentials).toHaveLength(1);
  });

  it('adds a second passkey with an assertion from an enrolled one', async () => {
    const first = new SoftAuthenticator();
    await enroll(first);
    const second = new SoftAuthenticator();
    const ch = await challenge({ purpose: 'add-passkey', credentialId: second.id });
    const res = await enroll(second, first.assert(ch));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await agent().get('/webauthn/status')).body.credentials).toHaveLength(2);
  });

  it('removes a passkey only with an assertion bound to its removal', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    expect((await agent().delete(`/webauthn/credentials/${a.id}`).set(board()).send({})).status).toBe(401);
    const ch = await challenge({ purpose: 'remove', credentialId: a.id });
    const res = await agent().delete(`/webauthn/credentials/${a.id}`).set(board()).send({ assertion: a.assert(ch) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get('/webauthn/status')).body.enrolled).toBe(false);
  });

  it("refuses the agent's channel", async () => {
    const res = await agent().post('/webauthn/challenge').set({ ...board(), ...internal() }).send({ purpose: 'enroll' });
    expect(res.status).toBe(403);
  });
});

describe('CGLAB-383: approvals on a step that asks for a passkey', () => {
  it('refuses an approval when no passkey is enrolled yet, saying to enroll one', async () => {
    const id = await card('PLAN');
    const res = await approve(id, {});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/enroll/i);
  });

  it('refuses an approval without an assertion: the board header is not enough', async () => {
    await enroll();
    const id = await card('PLAN');
    const res = await approve(id, {});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/passkey/i);
    expect((await validate(id)).status).toBe(422);
  });

  it('accepts an approval signed for this card and step, recording its authority', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await card('PLAN');
    const res = await approve(id, { note: 'go', assertion: await signedApproval(a, id, 'PLAN', 'go') });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ authority: 'passkey', credentialId: a.id });
    expect((await validate(id)).status).toBe(200);
  });

  it('refuses the same assertion twice', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await card('PLAN');
    const assertion = await signedApproval(a, id, 'PLAN');
    expect((await approve(id, { assertion })).status).toBe(201);
    expect((await approve(id, { assertion })).status).toBe(401);
  });

  it('refuses a replay even from an authenticator that keeps no sign count', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await card('PLAN');
    const ch = await challenge({ purpose: 'approval', itemId: id, step: 'PLAN' });
    const assertion = a.assert(ch, { signCount: 0 });
    expect((await approve(id, { assertion })).status).toBe(201);
    expect((await approve(id, { assertion })).status).toBe(401);
  });

  it('refuses an assertion signed for another card', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const one = await card('PLAN');
    const two = await card('PLAN');
    expect((await approve(two, { assertion: await signedApproval(a, one, 'PLAN') })).status).toBe(401);
  });

  it('refuses an assertion whose note differs from what was signed', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await card('PLAN');
    expect((await approve(id, { note: 'changed', assertion: await signedApproval(a, id, 'PLAN', 'go') })).status).toBe(401);
  });

  it('refuses an assertion from a passkey that is not enrolled', async () => {
    await enroll();
    const id = await card('PLAN');
    const stranger = new SoftAuthenticator();
    expect((await approve(id, { assertion: await signedApproval(stranger, id, 'PLAN') })).status).toBe(401);
  });

  it('refuses an assertion without user verification', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await card('PLAN');
    const ch = await challenge({ purpose: 'approval', itemId: id, step: 'PLAN' });
    expect((await approve(id, { assertion: a.assert(ch, { uv: false }) })).status).toBe(401);
  });
});

describe('CGLAB-383: overrides on a step that asks for a passkey', () => {
  const blocked = async (signed = true) => {
    const id = await card('WORK', signed);
    expect((await validate(id)).status).toBe(422);
    return id;
  };

  it('refuses an override without an assertion', async () => {
    await enroll();
    const id = await blocked();
    expect((await override(id, { checkId: 'jira-key-valid', reason: 'spike card' })).status).toBe(401);
  });

  it('a step that does not ask for a passkey takes an unsigned override, even with a passkey enrolled', async () => {
    await enroll();
    const id = await blocked(false);
    const res = await override(id, { checkId: 'jira-key-valid', reason: 'spike card' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.authority).toBe('unverified');
  });

  it('accepts an override signed for this check and reason', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await blocked();
    const reason = 'spike card, no issue';
    const ch = await challenge({ purpose: 'override', itemId: id, step: 'WORK', checkId: 'jira-key-valid', reason });
    const res = await override(id, { checkId: 'jira-key-valid', reason, assertion: a.assert(ch) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.authority).toBe('passkey');
    // WORK still waits for its own signed go-ahead; the override lifted jira-key-valid.
    const v = await validate(id);
    expect(v.body.checks.find((c: any) => c.id === 'jira-key-valid')).toMatchObject({ blocking: false });
  });

  it('refuses an override whose reason differs from what was signed', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await blocked();
    const ch = await challenge({ purpose: 'override', itemId: id, step: 'WORK', checkId: 'jira-key-valid', reason: 'spike card' });
    expect((await override(id, { checkId: 'jira-key-valid', reason: 'something else', assertion: a.assert(ch) })).status).toBe(401);
  });

  it('refuses an approval assertion used for an override', async () => {
    const a = new SoftAuthenticator();
    await enroll(a);
    const id = await blocked();
    const ch = await challenge({ purpose: 'approval', itemId: id, step: 'WORK' });
    expect((await override(id, { checkId: 'jira-key-valid', reason: 'x', assertion: a.assert(ch) })).status).toBe(401);
  });
});

describe('CGLAB-383: a step that does not ask for a passkey', () => {
  it('approvals work from the board as in S6, recorded as unverified', async () => {
    const id = await card('PLAN', false);
    const res = await approve(id, {});
    expect(res.status).toBe(201);
    expect(res.body.authority).toBe('unverified');
    expect((await item(id)).stepRecords.find((r: any) => r.kind === 'approval').authority).toBe('unverified');
  });
});

describe('CGLAB-383: signing is off by default and per step', () => {
  it('an enrolled passkey alone does not force signing on a step that does not ask for it', async () => {
    await enroll();
    const id = await card('PLAN', false);
    const res = await approve(id, {});
    expect(res.status).toBe(201);
    expect((await validate(id)).status).toBe(200);
  });

  it('an unsigned approval does not satisfy a step that asks for a passkey', async () => {
    const id = await card('PLAN');
    await storage.updateItem(id, { stepRecords: [{ step: 'PLAN', kind: 'approval', at: new Date().toISOString(), head: null, clean: false, by: 'board', authority: 'unverified' }] } as any);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/passkey/);
  });

  it('the shipped TDD flow does not ask for a passkey', async () => {
    const { TDD_FLOW_PRESET } = await import('@agenfk/core');
    const d = TDD_FLOW_PRESET.steps.find(st => st.name === 'DISCOVERY') as any;
    expect(d.checks.find((c: any) => c.id === 'human-approval').params?.signature ?? 'none').toBe('none');
  });

  it('refuses a signature param it does not know at save time', async () => {
    const steps = gatedFlow();
    (steps[1] as any).checks = [{ id: 'human-approval', params: { signature: 'retina' } }];
    expect((await agent().post('/flows').send({ name: `pk-${++seq}`, steps })).status).toBe(400);
  });
});

describe('CGLAB-383: GET /items/:id/gates says whether the step asks for a passkey', () => {
  it('true on a signed step, false elsewhere', async () => {
    expect((await agent().get(`/items/${await card('PLAN')}/gates`)).body.passkeyRequired).toBe(true);
    expect((await agent().get(`/items/${await card('PLAN', false)}/gates`)).body.passkeyRequired).toBe(false);
  });

  it('shows each approval with its authority', async () => {
    const id = await card('PLAN', false);
    await approve(id, {});
    expect((await agent().get(`/items/${id}/gates`)).body.approvals[0].authority).toBe('unverified');
  });
});
