/**
 * TDD for CGLAB-13 — the project's verifyCommand must always run in the project's
 * own working directory (the nearest `.agenfk` ancestor of the caller's cwd), not
 * in the AgEnFK server daemon's directory.
 *
 * The server is a single global daemon serving many projects, so
 * findProjectRoot(process.cwd()) resolves to wherever the daemon was launched —
 * the wrong directory for every project but the one it started in. Callers pass
 * their own `cwd` on /validate; the server must resolve it UP to the project root
 * and both (a) store that as project.projectRoot and (b) run the command there,
 * so verify works even when invoked from a subdirectory and needs no `cd` prefix.
 *
 * These reflect future functionality and are expected to fail until the server
 * resolves the caller cwd to the project root.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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

const TEST_DB = path.resolve('./verify-cwd-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, VERIFY_TOKEN } from '../server';

// A throwaway project tree: <root>/.agenfk + <root>/packages/cli (a subdir).
let projRoot: string;
let subDir: string;

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  if (projRoot && fs.existsSync(projRoot)) fs.rmSync(projRoot, { recursive: true, force: true });
});

async function waitForRun(runId: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await request(app).get(`/items/validate-runs/${runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (res.status !== 200) return res;
    if (res.body.status !== 'running') return res;
    if (Date.now() - start > timeoutMs) return res;
    await new Promise(r => setTimeout(r, 100));
  }
}

async function itemOnFinalStep(name: string, verifyCommand: string) {
  const p = (await request(app).post('/projects').send({ name })).body;
  await request(app).put(`/projects/${p.id}/verify-command`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ verifyCommand });
  const item = (await request(app).post('/items').send({ type: 'TASK', title: `${name}-item`, projectId: p.id })).body;
  await request(app)
    .post('/items/bulk')
    .set('x-agenfk-internal', VERIFY_TOKEN!)
    .send({ items: [{ id: item.id, updates: { status: 'TEST' } }] });
  return { projectId: p.id, item };
}

describe('CGLAB-13 — verifyCommand runs in the project working directory', () => {
  beforeEach(async () => {
    await initStorage();
    projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-verify-cwd-'));
    // realpath so macOS /var → /private/var symlink doesn't defeat the comparison.
    projRoot = fs.realpathSync(projRoot);
    fs.mkdirSync(path.join(projRoot, '.agenfk'), { recursive: true });
    subDir = path.join(projRoot, 'packages', 'cli');
    fs.mkdirSync(subDir, { recursive: true });
  });

  it('runs the command at the project ROOT even when the caller cwd is a subdirectory', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await itemOnFinalStep('CWD1', 'pwd');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, cwd: subDir });
    expect(res.status).toBe(202);

    const done = await waitForRun(res.body.runId);
    expect(done.body.status).toBe('passed');
    // `pwd` must print the repo root, NOT the subdirectory the caller was in.
    expect(done.body.output.trim()).toContain(projRoot);
    expect(done.body.output).not.toContain(path.join('packages', 'cli'));
  });

  it('stores project.projectRoot as the resolved project root, not the raw caller cwd', async () => {
    if (!VERIFY_TOKEN) return;
    const { projectId, item } = await itemOnFinalStep('CWD2', 'true');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, cwd: subDir });
    await waitForRun(res.body.runId);

    const proj = (await request(app).get(`/projects/${projectId}`)).body;
    expect(proj.projectRoot).toBe(projRoot);
  });

  it('non-regression: a cwd already AT the project root is stored/used unchanged (MCP-path invariant)', async () => {
    if (!VERIFY_TOKEN) return;
    const { projectId, item } = await itemOnFinalStep('CWD3', 'pwd');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, cwd: projRoot }); // MCP sends the project dir directly
    const done = await waitForRun(res.body.runId);

    expect(done.body.output.trim()).toContain(projRoot);
    const proj = (await request(app).get(`/projects/${projectId}`)).body;
    expect(proj.projectRoot).toBe(projRoot);
  });

  it('fallback: a caller cwd with no .agenfk ancestor is used as-is (returns the raw cwd)', async () => {
    if (!VERIFY_TOKEN) return;
    // A directory tree with NO .agenfk marker anywhere above it.
    const orphan = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-orphan-')));
    try {
      const { projectId, item } = await itemOnFinalStep('CWD4', 'true');
      const res = await request(app)
        .post(`/items/${item.id}/validate`)
        .set('x-agenfk-internal', VERIFY_TOKEN)
        .send({ async: true, cwd: orphan });
      await waitForRun(res.body.runId);

      const proj = (await request(app).get(`/projects/${projectId}`)).body;
      expect(proj.projectRoot).toBe(orphan);
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  });
});
