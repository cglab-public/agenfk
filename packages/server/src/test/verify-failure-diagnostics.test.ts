/**
 * @file BUG b233143b — a failing verifyCommand must say WHAT happened.
 *
 * Observed twice while driving a STORY to DONE: the final flow step ran
 * `npx vitest run` as its gate, it failed, and the diagnostics made the cause
 * harder to find than the fix. Three gaps:
 *
 *  1. The exit code was captured server-side (`code`) and used to derive
 *     pass/fail, but never reported. A suite that exits 1, a command killed by
 *     the AGENFK_VERIFY_MAX_MS cap (124) and a command that cannot be spawned
 *     at all (127) all read identically: "Validation Failed!".
 *  2. The only view of the output was a head-1KB + tail-1KB slice of a raw
 *     byte stream — for a 3000-test suite, unrelated chatter plus an arbitrary
 *     tail.
 *  3. The full log lived at <dbDir>/logs/<itemId>/<testId>.log, i.e. under
 *     ~/.agenfk-system on a system install, pruned to 3 per item, referenced
 *     only in a trailer. Nothing where an agent or human would look.
 *
 * Contract under test (deliberately DUMB, per the agreed design: a wrong
 * summary is worse than none, so no runner-specific parsing):
 *  - failure message states the exit code, or the timeout kill, explicitly;
 *  - failure message carries the LAST lines of raw output, not the head;
 *  - the full log is written under os.tmpdir(), and its path is named;
 *  - the previous <dbDir>/logs location is no longer used;
 *  - when the log cannot be written, the message says so instead of naming a
 *    path that does not exist.
 *
 * Same server message feeds the CLI (`agenfk verify`) and MCP
 * `validate_progress`, so fixing it here fixes both clients.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./verify-diagnostics-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Import AFTER the env var so storage lands in the test DB.
import { app, initStorage, VERIFY_TOKEN, getVerifyLogRoot } from '../server';

/** Item log dir for one item, under the OS temp root. */
const itemLogDir = (itemId: string) => path.join(getVerifyLogRoot(), itemId);
const dbLogsDir = () => path.join(path.dirname(TEST_DB), 'logs');

const rmrf = (p: string) => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); };

const setupItem = async (name: string) => {
  const p = (await request(app).post('/projects').send({ name })).body;
  const item = (await request(app).post('/items').send({ type: 'TASK', title: name, projectId: p.id })).body;
  await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });
  return { p, item };
};

/** 60 numbered lines, then a distinctive final line, then exit 1 — all INSIDE
 *  the node script: appending `process.exit(1)` after the quoted -e argument
 *  leaves it to the shell, which errors and echoes the command back, and then a
 *  test asserting on the echoed text passes without the program ever running. */
const FAILING_NOISE =
  `node -e "for (let i=1;i<=60;i++) console.log('noise line ' + i); console.log('THE_REAL_LAST_LINE'); process.exit(1)"`;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
});

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('POST /items/:id/validate — failure diagnostics (BUG b233143b)', () => {
  beforeEach(async () => { await initStorage(); });
  afterEach(() => { rmrf(getVerifyLogRoot()); rmrf(dbLogsDir()); });

  it('states the exit code explicitly when the command fails', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagExit');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: `node -e "console.log('failing-suite-output'); process.exit(3)"` });

    expect(res.status).toBe(422);
    // The number the command actually exited with — not a generic failure.
    expect(res.body.message).toMatch(/exit code\D*3/);
    expect(res.body.message).toContain('failing-suite-output');
  });

  it('distinguishes a command that could not be run from a suite that failed', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagMissing');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'this-binary-does-not-exist-agenfk' });

    expect(res.status).toBe(422);
    // 127 is "command not found" from the shell. Reported as itself, so a broken
    // PATH or a missing script is not misread as a red test suite.
    expect(res.body.message).toMatch(/exit code\D*127/);
  });

  it('names the runtime cap when the command was killed, not a plain failure', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagTimeout');
    process.env.AGENFK_VERIFY_MAX_MS = '500';
    try {
      const res = await request(app)
        .post(`/items/${item.id}/validate`)
        .set('x-agenfk-internal', VERIFY_TOKEN)
        .send({ command: 'node -e "setTimeout(() => {}, 30000)"' });

      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/cap|killed|timed out/i);
      expect(res.body.message).toMatch(/124/);
    } finally {
      delete process.env.AGENFK_VERIFY_MAX_MS;
    }
  });

  it('shows the TAIL of the output, where the outcome actually is', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagTail');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: FAILING_NOISE });

    expect(res.status).toBe(422);
    // Proof the command really ran, rather than the shell echoing it back.
    expect(res.body.message).not.toContain('syntax error');
    expect(res.body.message).toContain('THE_REAL_LAST_LINE');
    expect(res.body.message).toContain('noise line 60');
    // 60 lines of noise precede it; the message must not be a head-first slice.
    expect(res.body.message).not.toMatch(/noise line 1\b/);
  });

  it('writes the full log under the OS temp dir and names that path', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagTmpLog');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: FAILING_NOISE });

    const dir = itemLogDir(item.id);
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);

    // The named path is the one that exists, and it is inside os.tmpdir().
    // Both sides go through realpath: on macOS os.tmpdir() is /var/folders/…
    // while the canonical path is /private/var/folders/…, so a raw string
    // comparison would fail on a correct implementation.
    const named = path.dirname(res.body.message.match(/Full log:\s*(\S+)/)?.[1] ?? '');
    expect(named).toBe(dir);
    expect(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);

    // Full, untruncated output — the point of the file.
    const full = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(full).toContain('noise line 1');
    expect(full).toContain('THE_REAL_LAST_LINE');
  });

  it('no longer writes validation logs under the database directory', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagNoDbLogs');

    await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: `node -e "console.log('x'); process.exit(1)"` });

    // The old home was <dbDir>/logs/<itemId>/, i.e. ~/.agenfk-system/.agenfk/logs
    // on a system install — buried, and pruned to 3 with no hint where to look.
    expect(fs.existsSync(path.join(dbLogsDir(), item.id))).toBe(false);
  });

  it('keeps the log file private to the user (world-writable temp dir)', async () => {
    if (!VERIFY_TOKEN) return;
    if (typeof process.getuid !== 'function') return; // POSIX-only assertion
    const { item } = await setupItem('DiagPerms');

    await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: `node -e "console.log('secret-token-material'); process.exit(1)"` });

    // os.tmpdir() is shared. Test output routinely contains env vars and tokens,
    // so neither the directory nor the log may be readable by other users.
    const dirMode = fs.statSync(itemLogDir(item.id)).mode & 0o777;
    expect(dirMode & 0o077).toBe(0);
    const fileMode = fs.statSync(path.join(itemLogDir(item.id), fs.readdirSync(itemLogDir(item.id))[0])).mode & 0o777;
    expect(fileMode & 0o077).toBe(0);
  });

  it('says the log is unavailable rather than naming a path it could not write', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagUnwritable');

    // Make the temp root un-creatable by occupying it with a FILE: mkdirSync
    // fails, so there is no log to point at.
    rmrf(getVerifyLogRoot());
    fs.writeFileSync(getVerifyLogRoot(), 'not a directory');
    try {
      const res = await request(app)
        .post(`/items/${item.id}/validate`)
        .set('x-agenfk-internal', VERIFY_TOKEN)
        .send({ command: `node -e "console.log('still-reported'); process.exit(1)"` });

      expect(res.status).toBe(422);
      // The outcome must survive the missing log, not be replaced by a lie.
      expect(res.body.message).toContain('still-reported');
      expect(res.body.message).toMatch(/log.{0,60}(unavailable|could not be written)/is);
      expect(res.body.message).not.toMatch(/Full log:\s*\/\S/);
    } finally {
      rmrf(getVerifyLogRoot());
    }
  });

  it('reaches the CLI through the async run, not just the 422 body', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagAsync');

    // `agenfk verify` does not read the 422 — it polls
    // GET /items/validate-runs/:runId and prints run.message. Fixing only the
    // sync response would leave the client that motivated the fix unchanged.
    const started = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ async: true, command: `node -e "console.log('async-suite-failed'); process.exit(7)"` });
    expect(started.status).toBe(202);
    const runId = started.body.runId;

    let run: any = null;
    for (let i = 0; i < 100 && (!run || run.status === 'running'); i++) {
      await new Promise(r => setTimeout(r, 50));
      run = (await request(app)
        .get(`/items/validate-runs/${runId}`)
        .set('x-agenfk-internal', VERIFY_TOKEN)).body;
    }

    expect(run.status).toBe('failed');
    expect(run.message).toMatch(/exit code\D*7/);
    expect(run.message).toContain('async-suite-failed');
    expect(run.message).toContain('Full log: ');
  });

  it('still passes and advances when the command exits 0', async () => {
    if (!VERIFY_TOKEN) return;
    const { item } = await setupItem('DiagPass');

    const res = await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: 'node -e "console.log(\'green\')"' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Validation Passed/);
    expect(res.body.output).toContain('Full log:');
  });
});
