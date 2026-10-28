/**
 * SX-3 (8dd7c7c0): the server's own verify run, end to end through the app. A
 * card an Airlock sandbox touched, while the policy enforces, has its verify
 * command run through `agenfk airlock exec` (a stand-in CLI here, given by
 * AGENFK_AIRLOCK_EXEC_CLI, that says so and prints its arguments); any other
 * card's runs as before.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeEach, afterAll, vi, beforeAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('airlock-verify-sandboxed-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
const FAKE_CLI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-fake-cli-'));
const FAKE_CLI = path.join(FAKE_CLI_DIR, 'agenfk.js');
fs.writeFileSync(FAKE_CLI, "console.log('VIA-EXEC ' + JSON.stringify(process.argv.slice(2)));");
process.env.AGENFK_AIRLOCK_EXEC_CLI = FAKE_CLI;
// A stand-in that really runs the command it is given, in its own (the caller's) process group.
const RUNNING_CLI = path.join(FAKE_CLI_DIR, 'agenfk-run.js');
fs.writeFileSync(RUNNING_CLI, "const r = require('child_process').spawnSync('/bin/sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit' }); process.exit(r.status ?? 1);");

import { app, initStorage, closeStorage, VERIFY_TOKEN, storage } from '../server';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy } from '@agenfk/core';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => {
  await new Promise<void>((r) => __server.close(() => r()));
  await removeTestDb(TEST_DB, closeStorage);
  fs.rmSync(FAKE_CLI_DIR, { recursive: true, force: true });
  delete process.env.AGENFK_AIRLOCK_EXEC_CLI;
});

let projRoot: string;

async function waitForRun(runId: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await agent().get(`/items/validate-runs/${runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (res.status !== 200 || res.body.status !== 'running' || Date.now() - start > timeoutMs) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function setMode(mode: 'enforce' | 'observe'): Promise<void> {
  const current = await storage.getAirlockPolicy('local');
  await storage.putAirlockPolicy({
    scope: 'local', revision: (current?.revision ?? 0) + 1,
    policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode }),
    updatedAt: new Date().toISOString(), updatedBy: 'test', authority: 'local',
  }, current?.revision ?? 0);
}

async function itemOnFinalStep(name: string) {
  const p = (await agent().post('/projects').send({ name })).body;
  await agent().put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand: 'echo ran-directly' });
  const item = (await agent().post('/items').send({ type: 'TASK', title: `${name}-item`, projectId: p.id })).body;
  await storage.updateItem(item.id, { status: 'TEST' } as any);
  return item;
}

async function verify(itemId: string) {
  const res = await agent().post(`/items/${itemId}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ async: true, cwd: projRoot });
  expect(res.status).toBe(202);
  return (await waitForRun(res.body.runId)).body;
}

describePosix('SX-3: a covered card\'s verify runs in the Airlock sandbox', () => {
  beforeEach(async () => {
    await initStorage();
    projRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-verify-')));
    fs.mkdirSync(path.join(projRoot, '.agenfk'), { recursive: true });
  });

  it('covered, enforce: the verify command goes through agenfk airlock exec, in the project root', async () => {
    if (!VERIFY_TOKEN) return;
    await setMode('enforce');
    const item = await itemOnFinalStep('SX3-a');
    await storage.markAirlockCovered([item.id], new Date().toISOString());
    const done = await verify(item.id);
    expect(done.output).toContain('VIA-EXEC');
    expect(done.output).toContain(JSON.stringify(['airlock', 'exec', '--no-process-group', '--cwd', projRoot, '--', 'echo ran-directly']));
    expect(done.output).not.toMatch(/^ran-directly$/m);
  });

  it('a card nobody sandboxed runs its verify directly', async () => {
    if (!VERIFY_TOKEN) return;
    await setMode('enforce');
    const item = await itemOnFinalStep('SX3-b');
    const done = await verify(item.id);
    expect(done.output).toMatch(/^ran-directly$/m);
    expect(done.output).not.toContain('VIA-EXEC');
  });

  it('observe mode: a covered card runs directly (the sandbox is for enforce)', async () => {
    if (!VERIFY_TOKEN) return;
    await setMode('observe');
    const item = await itemOnFinalStep('SX3-c');
    await storage.markAirlockCovered([item.id], new Date().toISOString());
    const done = await verify(item.id);
    expect(done.output).toMatch(/^ran-directly$/m);
  });
});

describePosix('SX-3 review: a sandboxed verify that times out takes everything it started with it', () => {
  beforeEach(async () => {
    await initStorage();
    projRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-verify-')));
    fs.mkdirSync(path.join(projRoot, '.agenfk'), { recursive: true });
  });

  it('the run is killed as a group: a background child of the command does not survive', async () => {
    if (!VERIFY_TOKEN) return;
    process.env.AGENFK_AIRLOCK_EXEC_CLI = RUNNING_CLI;
    const before = process.env.AGENFK_VERIFY_MAX_MS;
    process.env.AGENFK_VERIFY_MAX_MS = '1500';
    try {
      await setMode('enforce');
      const pidFile = path.join(projRoot, 'sleeper.pid');
      const p = (await agent().post('/projects').send({ name: 'SX3-timeout' })).body;
      await agent().put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand: `sleep 600 & echo $! > ${pidFile}; wait` });
      const item = (await agent().post('/items').send({ type: 'TASK', title: 'timeout-item', projectId: p.id })).body;
      await storage.updateItem(item.id, { status: 'TEST' } as any);
      await storage.markAirlockCovered([item.id], new Date().toISOString());
      const done = await verify(item.id);
      expect(done.status).toBe('failed');
      const sleeper = Number(fs.readFileSync(pidFile, 'utf8').trim());
      await vi.waitFor(() => { let alive = true; try { process.kill(sleeper, 0); } catch { alive = false; } expect(alive).toBe(false); }, { timeout: 8000 });
    } finally {
      process.env.AGENFK_AIRLOCK_EXEC_CLI = FAKE_CLI;
      if (before === undefined) delete process.env.AGENFK_VERIFY_MAX_MS; else process.env.AGENFK_VERIFY_MAX_MS = before;
    }
  }, 30000);
});
