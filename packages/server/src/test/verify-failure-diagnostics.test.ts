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

// Per-run log root. The production default is a stable, machine-global name
// shared by every agenfk server this uid runs — so on a machine dogfooding
// agenfk, a suite that cleaned the root would delete a LIVE server's verify
// logs on every afterEach. The override keeps the tests off that path.
const LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-verifytest-'));
setVerifyLogRootForTests(LOG_ROOT);

// Import AFTER the env var so storage lands in the test DB.
import { app, initStorage, VERIFY_TOKEN, getVerifyLogRoot, setVerifyLogRootForTests } from '../server';

/** Item log dir for one item, under the temp root. */
const itemLogDir = (itemId: string) => path.join(getVerifyLogRoot(), itemId);
const dbLogsDir = () => path.join(path.dirname(TEST_DB), 'logs');

const rmrf = (p: string) => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); };
/** Empty the log root without deleting the root itself (other tests hold it). */
const clearLogRoot = () => {
  const root = getVerifyLogRoot();
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) rmrf(path.join(root, name));
};

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
  rmrf(LOG_ROOT);
  // process.env is process-global and vitest reuses workers: leaving this set
  // would redirect a sibling test file that expects the default root.
  setVerifyLogRootForTests(null);
});

describe('POST /items/:id/validate — failure diagnostics (BUG b233143b)', () => {
  beforeEach(async () => { await initStorage(); setVerifyLogRootForTests(LOG_ROOT); clearLogRoot(); });
  afterEach(() => { clearLogRoot(); rmrf(dbLogsDir()); setVerifyLogRootForTests(LOG_ROOT); });

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
    const blocker = path.join(LOG_ROOT, 'occupied');
    fs.writeFileSync(blocker, 'not a directory');
    setVerifyLogRootForTests(blocker);
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
      // A silent "couldn't write a log" is the same class of failure this module
      // exists to fix, so the reason is part of the contract.
      expect(res.body.message).toMatch(/log root refused/i);
    } finally {
      setVerifyLogRootForTests(LOG_ROOT);
      rmrf(blocker);
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

// One test per finding from the adversarial review. Each is written so a wrong
// implementation FAILS it — where that needed an extra assertion (the prune one
// asserts the OLD log really is deleted, or "keep everything" would pass), it is
// stated inline.
describe('POST /items/:id/validate — review findings (BUG b233143b)', () => {
  beforeEach(async () => {
    await initStorage();
    setVerifyLogRootForTests(LOG_ROOT);
    clearLogRoot();
  });
  afterEach(() => {
    clearLogRoot();
    delete process.env.AGENFK_VERIFY_MAX_MS;
    setVerifyLogRootForTests(LOG_ROOT);
  });

  /**
   * Fixture scripts go in a file. Quoting a multi-statement program inside a
   * shell `-e` string is how this file's first draft ended up asserting on the
   * text of a `/bin/sh` syntax error — the shell echoed the command back, the
   * asserted strings matched the echo, and the test passed without the program
   * ever running.
   */
  const script = (name: string, body: string): string => {
    const p = path.join(LOG_ROOT, name);
    fs.writeFileSync(p, body);
    return p;
  };

  const failCmd = `node -e "console.log('failing'); process.exit(1)"`;
  const validate = (itemId: string, command: string) =>
    request(app).post(`/items/${itemId}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ command });

  it('bounds the tail when the command reports progress with carriage returns', async () => {
    if (!VERIFY_TOKEN) return;
    // A \n-only splitter sees ONE line for \r progress output, so a line count
    // bounded nothing and the whole run went into the message — the field the
    // agent reads, and the one that is not byte-capped the way `output` is.
    const noisy = script('noisy-cr.js', `
      let s = '';
      for (let i = 0; i < 20000; i++) s += '\\rframe ' + i;
      s += '\\nTHE_REAL_FAILURE\\n';
      // The flush callback is load-bearing. Writes to a piped stdout are async,
      // so calling process.exit() straight after them discards whatever is still
      // queued: this fixture passed on a quiet laptop and lost its tail at frame
      // 3180 on a loaded CI runner, failing an assertion about OUR code when the
      // bug was in the fixture.
      process.stdout.write(s, () => process.exit(1));
    `);
    const { item } = await setupItem('DiagCR');

    const res = await validate(item.id, `node ${noisy}`);

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('THE_REAL_FAILURE');
    expect(res.body.message).not.toContain('frame 17');
    expect(res.body.message.length).toBeLessThan(8000);
    // The assertion that actually separates line-splitting from byte-capping.
    // Split on \r and the last 25 lines are ~300 bytes, so nothing needs
    // truncating. Do not split, and the whole run is ONE line, the byte cap
    // fires, and the marker appears — without it this test passes with the CR
    // handling deleted, which is how it first shipped.
    expect(res.body.message).not.toContain('tail truncated');
  });

  it('settles a cap-kill when a surviving grandchild holds the stdout pipe open', async () => {
    if (!VERIFY_TOKEN) return;
    // child.kill() signals the SHELL only. Vitest workers and npm lifecycle
    // scripts survive it and keep the inherited pipe open, and 'close' waits for
    // that pipe — so the cap did not bound the run at all: it stayed 'running'
    // and held the item's verify lock for as long as the orphan lived, which is
    // the exact lock the cap exists to prevent.
    const survivor = script('survivor.js', `
      const { spawn } = require('child_process');
      spawn('node', ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });
      setTimeout(() => {}, 20000);
    `);
    const { item } = await setupItem('DiagOrphan');
    process.env.AGENFK_VERIFY_MAX_MS = '400';
    const startedAt = Date.now();

    const res = await validate(item.id, `node ${survivor}`);
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/cap|killed/i);
    // The orphan holds the pipe for 20s; the run must not wait for it.
    expect(elapsed).toBeLessThan(6000);
  }, 25000);

  it('names the signal when the command dies by one, instead of "exit code null"', async () => {
    if (!VERIFY_TOKEN) return;
    // An OOM kill is ordinary on a constrained machine. "exit code null" is the
    // least informative thing this line could produce.
    const killer = script('self-kill.js', `process.kill(process.pid, 'SIGKILL');`);
    const { item } = await setupItem('DiagSignal');

    // `exec` replaces the shell with node, so the DIRECT child dies by signal —
    // otherwise the shell reports 128+9 and the null path is never exercised.
    const res = await validate(item.id, `exec node ${killer}`);

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/signal SIGKILL/);
    expect(res.body.message).not.toMatch(/exit code null/);
  });

  it('refuses a log root that is a symlink, even one pointing at our own directory', async () => {
    if (!VERIFY_TOKEN) return;
    if (typeof process.getuid !== 'function') return;
    // statSync FOLLOWS symlinks, so a uid check against the resolved target
    // answers "is the thing at the other end mine?" rather than "is this a real
    // directory I own?". The entry is checked, not the target.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-linktarget-'));
    const link = path.join(LOG_ROOT, 'planted');
    fs.symlinkSync(target, link);
    setVerifyLogRootForTests(link);
    try {
      const { item } = await setupItem('DiagSymlink');
      const res = await validate(item.id, failCmd);

      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/Full log: unavailable/);
      expect(res.body.message).toMatch(/log root refused/i);
      // Nothing was written through the link into the target tree.
      expect(fs.readdirSync(target)).toHaveLength(0);
    } finally {
      setVerifyLogRootForTests(LOG_ROOT);
      rmrf(target);
    }
  });

  it('never evicts the log it just promised, even when an older file looks newer', async () => {
    if (!VERIFY_TOKEN) return;
    // The prune ranks by mtime and evicts past the newest MAX_LOGS_PER_ITEM.
    // readdir order is filesystem hash order, so with a coarse or backdated
    // clock the file written three lines earlier could land in the evicted slice
    // — and the response would name a path the server had just unlinked.
    const { item } = await setupItem('DiagPruneKeep');

    const first = await validate(item.id, failCmd);
    const firstNamed = first.body.message.match(/Full log:\s*(\S+)/)?.[1];
    expect(fs.existsSync(firstNamed)).toBe(true);

    // Three decoys dated in the FUTURE, so the real log sorts last of the five.
    for (const name of ['a.log', 'b.log', 'c.log']) {
      const p = path.join(itemLogDir(item.id), name);
      fs.writeFileSync(p, 'decoy');
      const future = new Date(Date.now() + 600_000);
      fs.utimesSync(p, future, future);
    }

    const second = await validate(item.id, failCmd);
    const secondNamed = second.body.message.match(/Full log:\s*(\S+)/)?.[1];

    expect(secondNamed).toBeTruthy();
    expect(fs.existsSync(secondNamed)).toBe(true);
    // The prune really ran — without this, "keep every file" would pass too.
    expect(fs.existsSync(firstNamed)).toBe(false);
  });
});

describe('DELETE /projects/:id — purges verify logs with the project (BUG b233143b)', () => {
  beforeEach(async () => {
    await initStorage();
    setVerifyLogRootForTests(LOG_ROOT);
    clearLogRoot();
  });
  afterEach(() => { clearLogRoot(); });

  it('removes the item log directories that the hard delete would otherwise orphan', async () => {
    if (!VERIFY_TOKEN) return;
    const p = (await request(app).post('/projects').send({ name: 'PurgeProject' })).body;
    const item = (await request(app).post('/items').send({ type: 'TASK', title: 'x', projectId: p.id })).body;
    await request(app).put(`/items/${item.id}`).send({ status: 'IN_PROGRESS' });

    await request(app)
      .post(`/items/${item.id}/validate`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ command: `node -e "console.log('secret-token-material'); process.exit(1)"` });

    const dir = itemLogDir(item.id);
    expect(fs.existsSync(dir)).toBe(true);

    const del = await request(app)
      .delete(`/projects/${p.id}`)
      .set('x-agenfk-internal', VERIFY_TOKEN);
    expect(del.status).toBe(204);

    // deleteProject hard-deletes the item rows. Logs are keyed by item id, so if
    // they survive this call nothing can ever name them again — they would sit
    // on disk indefinitely holding raw command output that echoes environment.
    expect(fs.existsSync(dir)).toBe(false);
  });
});
