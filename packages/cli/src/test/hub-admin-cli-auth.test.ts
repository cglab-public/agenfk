/**
 * CGLAB-702 S1: `agenfk hub admin login | whoami | logout | sessions`.
 *
 * Driven against a REAL hub on loopback (createHubApp), not a mocked axios: the
 * point of these commands is the conversation with the hub, and a mock would
 * only pin what the test author believed the hub says.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import supertest from 'supertest';
import { registerHubCommands } from '../commands/hub';
import { createHubApp } from '../../../hub/src/server';
import { createPasswordUser } from '../../../hub/src/auth/password';
import { loginAs } from '../../../hub/src/test/helpers/loginAs';
import { drainApp } from '../../../hub/src/test/helpers/drainApp';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-admin-cli-')) };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});
vi.mock('@agenfk/telemetry', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getApiUrl: () => 'http://127.0.0.1:9',
  getInstallationId: () => 'inst-test',
}));

const AGENFK_DIR = path.join(sandboxHome, '.agenfk');
const ADMIN_CREDS = path.join(AGENFK_DIR, 'hub-admin.json');
const HUB_CONFIG = path.join(AGENFK_DIR, 'hub.json');
// A fresh directory per test: nothing is ever deleted while a hub may hold it open.
let dbDir: string;

let server: http.Server;
let hubUrl: string;
let ctx: any;
let adminCookie: string;
let exitSpy: any, logSpy: any, errSpy: any;

const out = () => logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
const err = () => errSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');

function program(): Command {
  const p = new Command();
  p.exitOverride();
  registerHubCommands(p);
  return p;
}
const run = (args: string[]) => program().parseAsync(args, { from: 'user' });

/** Runs `hub admin login`, approving the code it prints as `cookie`'s user. */
async function login(extra: string[] = ['--url', hubUrl], cookie = () => adminCookie): Promise<void> {
  const done = run(['hub', 'admin', 'login', ...extra, '--no-open']);
  let code: string | undefined;
  for (let i = 0; i < 100 && !code; i++) {
    code = out().match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
    if (!code) await new Promise(r => setTimeout(r, 50));
  }
  expect(code, `login printed no code; stdout:\n${out()}\nstderr:\n${err()}`).toBeTruthy();
  const r = await supertest(server).post('/hub/admin-device/approve').set('Cookie', cookie()).send({ userCode: code });
  expect(r.status).toBe(200);
  await done;
}

beforeEach(async () => {
  fs.rmSync(AGENFK_DIR, { recursive: true, force: true });
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cli-hub-admin-'));
  const hub = await createHubApp({ dbPath: path.join(dbDir, 'hub.sqlite'), secretKey: 'a'.repeat(64), sessionSecret: 'test-session-secret', defaultOrgId: 'org' });
  ctx = hub.ctx;
  server = hub.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  hubUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
  await createPasswordUser(ctx.db, 'org', 'view@x', 'longenough1', 'viewer');
  adminCookie = await loginAs(server, 'admin@x', 'longenough1');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Each step only if setup got that far, so a failed setup still removes its directory.
  // The DB is closed even if draining fails; the directory goes only after the close succeeded.
  try {
    try { if (server?.listening) await drainApp(server); } finally { if (ctx) await ctx.db.close(); }
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } finally {
    server = undefined as any; ctx = undefined; dbDir = undefined as any;
  }
});

describe('hub admin login', () => {
  it('signs in through the browser approval and stores the credential privately, apart from hub.json', async () => {
    await login();
    const creds = JSON.parse(fs.readFileSync(ADMIN_CREDS, 'utf8'));
    expect(creds.url).toBe(hubUrl);
    expect(creds.token).toMatch(/^agka_/);
    expect(creds.orgId).toBe('org');
    expect(creds.email).toBe('admin@x');
    expect(Date.parse(creds.expiresAt)).toBeGreaterThan(Date.now());
    if (process.platform !== 'win32') expect(fs.statSync(ADMIN_CREDS).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(HUB_CONFIG)).toBe(false);
    expect(out()).toContain('admin@x');
  }, 30_000);

  it('uses the hub from hub.json when --url is not given', async () => {
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(HUB_CONFIG, JSON.stringify({ url: hubUrl, token: 'agk_x', orgId: 'org' }), { mode: 0o600 });
    await login([]);
    expect(JSON.parse(fs.readFileSync(ADMIN_CREDS, 'utf8')).url).toBe(hubUrl);
  }, 30_000);

  it('with no --url and no hub.json, says what to pass and writes nothing', async () => {
    await expect(run(['hub', 'admin', 'login', '--no-open'])).rejects.toThrow(/exit 1/);
    expect(err()).toMatch(/--url/);
    expect(fs.existsSync(ADMIN_CREDS)).toBe(false);
  });

  it('refuses an endpoint that is not an AgEnFK hub, before anything is written', async () => {
    const impostor = http.createServer((_q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"service":"other"}'); });
    impostor.listen(0, '127.0.0.1');
    await new Promise<void>(r => impostor.once('listening', () => r()));
    try {
      const url = `http://127.0.0.1:${(impostor.address() as any).port}`;
      await expect(run(['hub', 'admin', 'login', '--url', url, '--no-open'])).rejects.toThrow(/exit 1/);
      expect(err()).toMatch(/agenfk-hub/);
      expect(fs.existsSync(ADMIN_CREDS)).toBe(false);
    } finally {
      await new Promise<void>(r => impostor.close(() => r()));
    }
  });
});

describe('hub admin whoami', () => {
  it('names the signed-in admin, as text and as --json', async () => {
    await login();
    logSpy.mockClear();
    await run(['hub', 'admin', 'whoami']);
    expect(out()).toContain('admin@x');
    expect(out()).toContain('admin');
    logSpy.mockClear();
    await run(['hub', 'admin', 'whoami', '--json']);
    const me = JSON.parse(out());
    expect(me.email).toBe('admin@x');
    expect(me.role).toBe('admin');
    expect(me.orgId).toBe('org');
    expect(me.url).toBe(hubUrl);
  }, 30_000);

  it('when not signed in, exits 1 and says to log in', async () => {
    await expect(run(['hub', 'admin', 'whoami'])).rejects.toThrow(/exit 1/);
    expect(err()).toContain('agenfk hub admin login');
  });

  it('when the hub has revoked the session, exits 1 and says to log in again', async () => {
    await login();
    await ctx.db.run('UPDATE admin_cli_tokens SET revoked_at = ?', [new Date().toISOString()]);
    await expect(run(['hub', 'admin', 'whoami'])).rejects.toThrow(/exit 1/);
    expect(err()).toMatch(/expired or revoked/i);
    expect(err()).toContain('agenfk hub admin login');
  }, 30_000);

  it('when the user is no longer an admin, says so rather than "log in again"', async () => {
    await login();
    await ctx.db.run("UPDATE users SET role = 'viewer' WHERE email = 'admin@x'");
    await expect(run(['hub', 'admin', 'sessions', 'list'])).rejects.toThrow(/exit 1/);
    expect(err()).toMatch(/admin role required/i);
  }, 30_000);
});

describe('hub admin logout', () => {
  it('revokes the token on the hub and removes the local credential', async () => {
    await login();
    const { token } = JSON.parse(fs.readFileSync(ADMIN_CREDS, 'utf8'));
    await run(['hub', 'admin', 'logout']);
    expect(fs.existsSync(ADMIN_CREDS)).toBe(false);
    const r = await supertest(server).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
  }, 30_000);

  it('still removes the local credential when the hub cannot be reached, and says the token was not revoked', async () => {
    await login();
    const creds = JSON.parse(fs.readFileSync(ADMIN_CREDS, 'utf8'));
    fs.writeFileSync(ADMIN_CREDS, JSON.stringify({ ...creds, url: 'http://127.0.0.1:9' }), { mode: 0o600 });
    // Exit 1: a script must not read "signed out" while a copied credential still works.
    await expect(run(['hub', 'admin', 'logout'])).rejects.toThrow(/exit 1/);
    expect(fs.existsSync(ADMIN_CREDS)).toBe(false);
    expect(err()).toMatch(/not revoked/i);
  }, 30_000);
});

describe('hub admin sessions', () => {
  it('lists CLI sessions and revokes one by id', async () => {
    await login();
    logSpy.mockClear();
    await run(['hub', 'admin', 'sessions', 'list', '--json']);
    const sessions = JSON.parse(out());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userEmail).toBe('admin@x');

    await run(['hub', 'admin', 'sessions', 'revoke', sessions[0].id, '--yes']);
    // That was our own session: the next call is refused.
    await expect(run(['hub', 'admin', 'whoami'])).rejects.toThrow(/exit 1/);
  }, 30_000);

  it('revoke without --yes refuses and changes nothing', async () => {
    await login();
    logSpy.mockClear();
    await run(['hub', 'admin', 'sessions', 'list', '--json']);
    const [s] = JSON.parse(out());
    await expect(run(['hub', 'admin', 'sessions', 'revoke', s.id])).rejects.toThrow(/exit 1/);
    expect(err()).toContain('--yes');
    await run(['hub', 'admin', 'whoami']);
  }, 30_000);
});
