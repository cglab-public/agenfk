/**
 * @file CGLAB-385 (S9-T2) — an older agenfk CLI (v1.1.20) against this server.
 *
 * Replays the requests that CLI sends, in its shapes, and checks each answer
 * is one it can act on: verify with a positional command and no actor, a
 * forward `update --status`, a flow PUT that knows nothing of roles, and a
 * review step it has no command to satisfy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./old-clients-compat-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-old-cli-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}
let seq = 0;
async function card(status: string, project: Record<string, unknown>) {
  const p = await agent().post('/projects').send({ name: `old-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: repo(), ...project } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `old-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
/** v1.1.20's verify: `{ evidence, async: true, cwd, command? }`, no actor; then it polls the run. */
async function oldVerify(id: string, command?: string) {
  const res = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'done', async: true, cwd: process.cwd(), ...(command ? { command } : {}) });
  if (res.status !== 202) return res;
  for (let i = 0; i < 200; i++) {
    const run = await agent().get(`/items/validate-runs/${res.body.runId}`).set(internal());
    if (run.body.status !== 'running') return run;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

describe('v1.1.20 CLI against this server', () => {
  it("verify with a positional command: accepted, the project's command runs instead", async () => {
    const id = await card('TEST', { verifyCommand: 'exit 1' });
    const res = await oldVerify(id, 'true');
    expect(res.body.status === 'failed' || res.status === 422 || res.status === 400, JSON.stringify(res.body)).toBe(true);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('TEST');
  });

  it('a forward update --status is refused in the error shape it prints, naming verify', async () => {
    const id = await card('IN_PROGRESS', { verifyCommand: 'exit 0' });
    const res = await agent().put(`/items/${id}`).send({ status: 'REVIEW' });
    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toMatch(new RegExp(`agenfk verify ${id}`));
  });

  it("a flow edit that knows nothing of roles keeps the step's contract", async () => {
    const f = await agent().post('/flows').send({ name: `old-${++seq}`, steps: [
      { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { id: 'b', name: 'BUILD', label: 'Build', order: 1, role: 'coding', checks: [{ id: 'jira-key-valid' }] },
      { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
    ] });
    const flow = (await agent().get(`/flows/${f.body.id}`)).body;
    // v1.1.20's `flow edit`: PUT { ...flow, steps } with its own step objects, which carry no role/checks.
    const steps = flow.steps.map((s: any) => ({ id: s.id, name: s.name, label: s.name === 'BUILD' ? 'Build it' : s.label, order: s.order, exitCriteria: s.exitCriteria, isAnchor: s.isAnchor }));
    expect((await agent().put(`/flows/${f.body.id}`).send({ ...flow, steps })).status).toBe(200);
    const build = (await agent().get(`/flows/${f.body.id}`)).body.steps.find((s: any) => s.name === 'BUILD');
    expect(build).toMatchObject({ label: 'Build it', role: 'coding', checks: [{ id: 'jira-key-valid' }] });
  });

  it('a review step it cannot satisfy says how: upgrade agenfk, or a person overrides on the board', async () => {
    const id = await card('REVIEW', { verifyCommand: 'exit 0' });
    const res = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'done', actor: { client: 'claude-code', sessionId: 'author' } });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/agenfk upgrade/);
    expect(res.body.message).toMatch(/override/i);
  });
});
