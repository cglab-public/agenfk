/**
 * @file 3ffc9651 — a command check's pass is shared by the cards of one tree at one state.
 *
 * A command check sees only its argv and the tree it runs in, never the card,
 * so two cards leaving a step at the same tree state would run the same command
 * on the same inputs. The simulation ran one six times for three siblings. A
 * pass is now shared: same project, same tree, same argv, same HEAD, same index
 * and the same content of every tracked and untracked file, for a bounded time.
 * Shared by default; a check
 * whose command reads something outside the tree opts out with share: none.
 * Only a pass is shared - a failure may be a flake - and a run that saw the
 * tree change under it is not shared either.
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

const TEST_DB = path.resolve('./command-check-sharing-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/**
 * A project in a fresh repo whose WORK step carries one command check. The
 * command appends to a file outside the tree (so each run is counted), sleeps
 * `sleepMs`, then exits `exitCode`; `extra` goes into the check's params.
 */
async function setup({ exitCode = 0, sleepMs = 0, extra = {} as Record<string, string>, writeIntoTree = false } = {}) {
  const repo = tmp('agenfk-ccs-repo-');
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  const runs = path.join(tmp('agenfk-ccs-runs-'), 'runs');
  const code = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(runs)},'run\\n');${writeIntoTree ? "fs.writeFileSync('a','changed by the run\\n');" : ''}setTimeout(()=>process.exit(${exitCode}),${sleepMs});`;
  const check = { id: 'command-check', params: { name: 'lint', argv: [process.execPath, '-e', code], ...extra } };
  const f = await agent().post('/flows').send({ name: `ccs-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [check] }), s('NEXT', 2), s('END', 3, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `ccs-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo } as never);
  const card = async () => {
    const c = await agent().post('/items').send({ type: 'TASK', title: `ccs-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    return c.body.id as string;
  };
  const count = () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
  return { repo, card, count, pid: p.body.id as string, flowId: f.body.id as string };
}

const verdict = async (id: string) => {
  const r = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
  const item = (await agent().get(`/items/${id}`)).body;
  const check = (item.lastChecks?.results ?? []).find((x: any) => x.id === 'command-check:lint');
  return { status: r.status, moved: item.status !== 'WORK', check };
};

describe('3ffc9651: a command check\'s pass is shared at the same tree state', () => {
  it('a second card at the same state takes the first card\'s pass without running the command', async () => {
    const t = await setup();
    const [a, b] = [await t.card(), await t.card()];
    const va = await verdict(a);
    expect(va.check).toMatchObject({ outcome: 'pass' });
    expect(va.moved).toBe(true);
    expect(t.count()).toBe(1);

    const vb = await verdict(b);
    expect(vb.check).toMatchObject({ outcome: 'pass' });
    expect(vb.moved).toBe(true);
    expect(t.count(), 'the command ran again on the same inputs').toBe(1);
    // Said so, naming the card whose run it is.
    expect(vb.check.detail).toMatch(new RegExp(`reused\\b[\\s\\S]*${a.slice(0, 8)}`, 'i'));
  });

  it('on a dirty tree too, when the content is the same', async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'another agent is mid-edit\n');
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('pass');
    expect((await verdict(b)).check.outcome).toBe('pass');
    expect(t.count()).toBe(1);
  });

  it('share: none runs it for every card', async () => {
    const t = await setup({ extra: { share: 'none' } });
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('pass');
    const vb = await verdict(b);
    expect(vb.check.outcome).toBe('pass');
    expect(vb.check.detail).not.toMatch(/reused/i);
    expect(t.count()).toBe(2);
  });

  it('a failure is not shared: the next card runs the command itself', async () => {
    const t = await setup({ exitCode: 3 });
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('fail');
    expect((await verdict(b)).check.outcome).toBe('fail');
    expect(t.count()).toBe(2);
  });

  it('the tree changed between the two: the next card runs it', async () => {
    const t = await setup();
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('pass');
    fs.writeFileSync(path.join(t.repo, 'a'), 'edited\n');
    expect((await verdict(b)).check.outcome).toBe('pass');
    expect(t.count()).toBe(2);
  });

  it('a run that changed the tree while it ran is not shared, even once the tree is back where it started', async () => {
    // What the command saw is not the state it started on, so its pass speaks for neither.
    const t = await setup({ writeIntoTree: true });
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('pass');
    fs.writeFileSync(path.join(t.repo, 'a'), 'a\n');
    expect((await verdict(b)).check.outcome).toBe('pass');
    expect(t.count()).toBe(2);
  });

  // Review: a command also sees the index and HEAD - a staged-files linter, a check on the branch.
  it('a different index is another state: a card that staged other files runs it', async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.repo, 'notes.txt'), 'x\n');
    execSync('git add notes.txt', { cwd: t.repo });
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('pass');
    execSync('git reset -q notes.txt', { cwd: t.repo });
    expect((await verdict(b)).check.outcome).toBe('pass');
    expect(t.count()).toBe(2);
  });

  it('another HEAD is another state for a command check', async () => {
    const t = await setup();
    const [a, b] = [await t.card(), await t.card()];
    expect((await verdict(a)).check.outcome).toBe('pass');
    execSync('git commit -q --allow-empty -m other', { cwd: t.repo });
    expect((await verdict(b)).check.outcome).toBe('pass');
    expect(t.count()).toBe(2);
  });

  it('a kept pass expires: past its time the command runs again', async () => {
    const before = process.env.AGENFK_COMMAND_SHARE_TTL_MS;
    process.env.AGENFK_COMMAND_SHARE_TTL_MS = '50';
    try {
      const t = await setup();
      const [a, b] = [await t.card(), await t.card()];
      expect((await verdict(a)).check.outcome).toBe('pass');
      await new Promise(r => setTimeout(r, 120));
      expect((await verdict(b)).check.outcome).toBe('pass');
      expect(t.count()).toBe(2);
    } finally {
      if (before === undefined) delete process.env.AGENFK_COMMAND_SHARE_TTL_MS; else process.env.AGENFK_COMMAND_SHARE_TTL_MS = before;
    }
  });

  it('another project in the same tree does not share it', async () => {
    const t = await setup();
    const a = await t.card();
    expect((await verdict(a)).check.outcome).toBe('pass');
    const p2 = await agent().post('/projects').send({ name: `ccs-${++seq}` });
    await storage.updateProject(p2.body.id, { flowId: t.flowId, projectRoot: t.repo } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: `ccs-${++seq}`, projectId: p2.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    expect((await verdict(c.body.id)).check.outcome).toBe('pass');
    expect(t.count()).toBe(2);
  });

  it('two cards verifying at once run the command once', async () => {
    const t = await setup({ sleepMs: 800 });
    const [a, b] = [await t.card(), await t.card()];
    const [va, vb] = await Promise.all([verdict(a), verdict(b)]);
    expect(va.check.outcome).toBe('pass');
    expect(vb.check.outcome).toBe('pass');
    expect(t.count()).toBe(1);
  });

  it('a waiting card whose owner fails runs the command itself', async () => {
    const t = await setup({ sleepMs: 500, exitCode: 1 });
    const [a, b] = [await t.card(), await t.card()];
    const [va, vb] = await Promise.all([verdict(a), verdict(b)]);
    expect(va.check.outcome).toBe('fail');
    expect(vb.check.outcome).toBe('fail');
    expect(t.count()).toBe(2);
  });
});
