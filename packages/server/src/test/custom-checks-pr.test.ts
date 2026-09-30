/**
 * @file C3b (efcacdeb) — what the PR and the waiting verify need from the
 * server about custom checks:
 *  - GET /items/:id/custom-checks: every custom check (command or agent) that
 *    a card of the tree passed a step with, from its exit records, and who
 *    approved a command. A reviewer must see which results the server checked
 *    and which it took on the agent's word.
 *  - GET /items/:id/gates carries `commandApprovedAt`, so a verify waiting on
 *    a person's command approval can tell when one lands.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./custom-checks-pr-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { argvHash } from '../commandChecks';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
const ARGV = [process.execPath, '-e', 'process.exit(0)'];
const checks = [
  { id: 'command-check', params: { name: 'lint', argv: ARGV, approval: 'person' } },
  { id: 'agent-check', params: { name: 'docs', instruction: 'Add a README line.' } },
];

async function project() {
  const f = await agent().post('/flows').send({ name: `ccpr-${++seq}`, steps: [s('TODO', 0, { isAnchor: true }), s('WORK', 1, { checks }), s('NEXT', 2), s('DONE', 3, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ccpr-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `ccpr-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return p.body.id as string;
}
async function card(projectId: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `Card ${++seq}`, projectId, ...extra });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return c.body.id as string;
}
const approveCommand = (projectId: string, at = '2026-09-25T10:00:00.000Z') =>
  storage.updateProject(projectId, { commandApprovals: [{ hash: argvHash(ARGV), argv: ARGV, at, by: 'board', authority: 'passkey' }] } as never);
const validate = (id: string, agentChecks?: unknown) =>
  agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok', ...(agentChecks ? { agentChecks } : {}) });

describe('GET /items/:id/custom-checks', () => {
  it("lists the custom checks each card of the tree passed a step with, and who approved a command", async () => {
    const pid = await project();
    const parent = await card(pid);
    const child = await card(pid, { parentId: parent });
    await approveCommand(pid);
    const r = await validate(child, [{ name: 'docs', outcome: 'pass', note: 'README has the mul line' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const res = await agent().get(`/items/${parent}/custom-checks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: child, step: 'WORK', check: 'lint', kind: 'command', outcome: 'pass', ran: true, approval: expect.objectContaining({ by: 'board', authority: 'passkey', at: '2026-09-25T10:00:00.000Z' }) }),
      expect.objectContaining({ itemId: child, step: 'WORK', check: 'docs', kind: 'agent', outcome: 'pass', reported: true, note: 'README has the mul line' }),
    ]));
  });

  it('names the approval the command RAN under, not one given later (C3b review)', async () => {
    const pid = await project();
    const id = await card(pid);
    await approveCommand(pid, '2026-09-25T10:00:00.000Z');
    expect((await validate(id, [{ name: 'docs', outcome: 'pass' }])).status).toBe(200);
    await approveCommand(pid, '2026-09-26T08:00:00.000Z');
    const lint = (await agent().get(`/items/${id}/custom-checks`)).body.find((r: any) => r.check === 'lint');
    expect(lint.approval.at).toBe('2026-09-25T10:00:00.000Z');
  });

  it('keeps only the last result per step and check when a step is left twice (C3b review)', async () => {
    const pid = await project();
    const id = await card(pid);
    await approveCommand(pid);
    expect((await validate(id, [{ name: 'docs', outcome: 'pass', note: 'first' }])).status).toBe(200);
    await storage.updateItem(id, { status: 'WORK' } as any);
    expect((await validate(id, [{ name: 'docs', outcome: 'pass', note: 'second' }])).status).toBe(200);
    const docs = (await agent().get(`/items/${id}/custom-checks`)).body.filter((r: any) => r.check === 'docs');
    expect(docs).toHaveLength(1);
    expect(docs[0].note).toBe('second');
  });

  it('is empty for a tree that passed no custom check', async () => {
    const pid = await project();
    const id = await card(pid);
    const res = await agent().get(`/items/${id}/custom-checks`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('404s for a card that does not exist', async () => {
    expect((await agent().get('/items/nope/custom-checks')).status).toBe(404);
  });
});

describe('GET /items/:id/gates: commandApprovals', () => {
  it('lists each approved command by hash and time, so a wait wakes only for its own command', async () => {
    const pid = await project();
    const id = await card(pid);
    expect((await agent().get(`/items/${id}/gates`)).body.commandApprovals).toEqual([]);
    await approveCommand(pid, '2026-09-25T11:00:00.000Z');
    expect((await agent().get(`/items/${id}/gates`)).body.commandApprovals).toEqual([{ hash: argvHash(ARGV), at: '2026-09-25T11:00:00.000Z' }]);
  });

  it("a refusal on a command waiting for approval names that command's hash, for the wait (C3b review)", async () => {
    const pid = await project();
    const id = await card(pid);
    const r = await validate(id, [{ name: 'docs', outcome: 'pass' }]);
    expect(r.status).toBe(422);
    const lint = r.body.checks.find((c: any) => c.id === 'command-check:lint');
    expect(lint.meta.waiting).toEqual(expect.objectContaining({ kind: 'command-approval', hash: argvHash(ARGV) }));
  });
});
