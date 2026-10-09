/**
 * @file GitHub #200 — the server's hot paths must launch their child processes
 * hidden (`windowsHide: true`).
 *
 * The API server has no console, so on Windows each child it starts without
 * CREATE_NO_WINDOW gets a new visible console window that steals focus. The two
 * paths an agent hits on every task are the verify-command runner (every
 * `agenfk verify`) and the close commit (every DONE). Both are driven here for
 * real, with child_process wrapped so every call's options can be inspected.
 * The per-call-site invariant for everything else is pinned by
 * windows-hide-guard.test.ts.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const recorded = vi.hoisted(() => [] as { fn: string; args: unknown[] }[]);

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const record = <K extends 'exec' | 'execSync' | 'execFile' | 'execFileSync' | 'spawn' | 'spawnSync'>(fn: K) =>
    ((...args: unknown[]) => {
      recorded.push({ fn, args });
      return (real[fn] as (...a: unknown[]) => unknown)(...args);
    }) as unknown as (typeof real)[K];
  const wrapped = {
    exec: record('exec'),
    execSync: record('execSync'),
    execFile: record('execFile'),
    execFileSync: record('execFileSync'),
    spawn: record('spawn'),
    spawnSync: record('spawnSync'),
  };
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('windows-hide-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { execSync } from 'child_process';
import { app, initStorage, VERIFY_TOKEN, autoGitCommit, storage } from '../server';
import { readGitStatus } from '../gitStatus';

/** ONE listening server for the file - per-call ephemeral servers flake (BUG 9de0c99c). */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });

/** The options object of a recorded call (the first plain-object argument). */
const optionsOf = (args: unknown[]) =>
  args.find(a => typeof a === 'object' && a !== null && !Array.isArray(a)) as Record<string, unknown> | undefined;
const unhidden = () =>
  recorded.filter(c => optionsOf(c.args)?.windowsHide !== true)
    .map(c => `${c.fn}(${JSON.stringify(c.args[0])})`);

const tmpDirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
};

afterAll(() => {
  // Best-effort: on Windows the storage handle stays open until the worker
  // exits, so unlinking here throws EBUSY; the file is recreated fresh at the
  // top of the next run anyway.
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(`${TEST_DB}${suffix}`, { force: true }); } catch { /* EBUSY on Windows */ }
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function waitForRun(runId: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await agent().get(`/items/validate-runs/${runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (res.status !== 200 || res.body.status !== 'running' || Date.now() - start > timeoutMs) return res;
    await new Promise(r => setTimeout(r, 100));
  }
}

describe('GitHub #200 — server child processes are spawned hidden', () => {
  beforeEach(async () => {
    await initStorage();
  });

  it('the worktree status poll (refetched every few seconds by the board) runs git hidden', async () => {
    const dir = tmp('agenfk-winhide-status-');
    execSync('git init -q', { cwd: dir, stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');

    recorded.length = 0;
    const status = await readGitStatus(dir);

    expect(status).toBeTruthy();
    expect(recorded.some(c => c.fn === 'execFile' && c.args[0] === 'git')).toBe(true);
    expect(unhidden()).toEqual([]);
  });

  it('the close commit runs every git command hidden', async () => {
    const dir = tmp('agenfk-winhide-commit-');
    const git = (cmd: string) => execSync('git ' + cmd, { cwd: dir, stdio: 'pipe', windowsHide: true });
    git('init -q');
    git('config user.email test@example.com');
    git('config user.name Tester');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    git('add a.txt');
    git('commit -q -m initial');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
    git('add a.txt');

    recorded.length = 0;
    const r = await autoGitCommit({ id: 'w1', type: 'BUG', title: 'hidden' } as any, dir);

    expect(r.committed).toBe(true);
    expect(recorded.length).toBeGreaterThan(0);
    expect(unhidden()).toEqual([]);
  });

  it('the verify-command runner spawns the project command hidden', async () => {
    const projRoot = tmp('agenfk-winhide-verify-');
    fs.mkdirSync(path.join(projRoot, '.agenfk'), { recursive: true });

    const p = (await agent().post('/projects').send({ name: 'WINHIDE' })).body;
    await agent().put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ verifyCommand: 'node --version' });
    const item = (await agent().post('/items').send({ type: 'TASK', title: 'winhide-item', projectId: p.id })).body;
    await storage.updateItem(item.id, { status: 'TEST' } as any);

    recorded.length = 0;
    const res = await agent().post(`/items/${item.id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, cwd: projRoot });
    expect(res.status).toBe(202);
    await waitForRun(res.body.runId);

    expect(recorded.some(c => c.fn === 'spawn' && c.args[0] === 'node --version')).toBe(true);
    expect(unhidden()).toEqual([]);
  });
});
