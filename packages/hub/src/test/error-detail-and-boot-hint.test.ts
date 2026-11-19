/** 500 responses hide err.message unless AGENFK_HUB_DEBUG_ERRORS=1; boot hints the renamed org id on a mismatch. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp, hubErrorHandler } from '../server';
import { drainApp } from './helpers/drainApp';

const FLAG = 'AGENFK_HUB_DEBUG_ERRORS';
// Module scope: removed only after the hub's database is closed.
const ERR_DB = path.join(os.tmpdir(), `agenfk-hub-errdetail-${process.pid}.sqlite`);
const cleanErrDb = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(ERR_DB + s)) fs.unlinkSync(ERR_DB + s); };

/** Run the real handler against a fake response and return what it answered. */
function answer(err: unknown): { status: number; body: any } {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    headersSent: false, locals: {},
    status(s: number) { out.status = s; return res; },
    json(b: unknown) { out.body = b; return res; },
  };
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { hubErrorHandler(err, {} as any, res, (() => {}) as any); } finally { spy.mockRestore(); }
  return out;
}

describe('hubErrorHandler: 500 detail is opt-in', () => {
  let savedEnv: string | undefined; let savedFlag: string | undefined;
  beforeEach(() => { savedEnv = process.env.NODE_ENV; savedFlag = process.env[FLAG]; delete process.env[FLAG]; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
    if (savedFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = savedFlag;
  });
  const driverError = () => new Error('relation "auth_config" does not exist');

  it.each(['test', 'development', 'staging', undefined])('hides the message by default when NODE_ENV is %s', (nodeEnv) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    const r = answer(driverError());
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'internal error' });
  });

  it('shows the message outside production when AGENFK_HUB_DEBUG_ERRORS=1', () => {
    process.env.NODE_ENV = 'staging';
    process.env[FLAG] = '1';
    expect(answer(driverError()).body).toEqual({ error: 'relation "auth_config" does not exist' });
  });

  it.each(['0', '', 'true', 'yes', 'on', ' 1x'])('only the exact value 1 turns it on: %j stays off', (value) => {
    process.env.NODE_ENV = 'staging';
    process.env[FLAG] = value;
    expect(answer(driverError()).body).toEqual({ error: 'internal error' });
  });

  it('never shows the message in production, even with the flag left on', () => {
    process.env.NODE_ENV = 'production';
    process.env[FLAG] = '1';
    expect(answer(driverError()).body).toEqual({ error: 'internal error' });
  });

  it('keeps 4xx messages as they were: they are client errors and name no table', () => {
    process.env.NODE_ENV = 'staging';
    const bad: any = new Error('Unexpected token } in JSON at position 3'); bad.status = 400;
    expect(answer(bad)).toEqual({ status: 400, body: { error: 'Unexpected token } in JSON at position 3' } });
    const hidden: any = new Error('secret detail'); hidden.status = 400; hidden.expose = false;
    expect(answer(hidden).body).toEqual({ error: 'bad request' });
  });

  it('a non-Error throw still answers 500 without echoing anything', () => {
    process.env.NODE_ENV = 'staging';
    expect(answer('a string was thrown')).toEqual({ status: 500, body: { error: 'internal error' } });
  });

  it('still LOGS the real message, so an operator can diagnose without exposing it', () => {
    process.env.NODE_ENV = 'staging';
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(' ')); });
    try {
      const res: any = { headersSent: false, locals: {}, status() { return res; }, json() { return res; } };
      hubErrorHandler(driverError(), {} as any, res, (() => {}) as any);
    } finally { spy.mockRestore(); }
    expect(seen.join('\n')).toContain('relation "auth_config" does not exist');
  });

  it('end to end: an unauthenticated route that fails does not leak the driver error on a non-production hub', async () => {
    cleanErrDb();
    process.env.NODE_ENV = 'staging';
    const out = await createHubApp({ dbPath: ERR_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' } as any);
    const server = out.app.listen(0);
    try {
      (out.ctx.db as any).get = async () => { throw new Error('relation "auth_config" does not exist'); };
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await supertest(server).get('/auth/providers');
      quiet.mockRestore();
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain('auth_config');
    } finally {
      out.ctx.stopWorkers?.(); await drainApp(server); await out.ctx.db.close(); cleanErrDb();
    }
  });
});

describe('boot points at the pending org rename', () => {
  const DB = path.join(os.tmpdir(), `agenfk-hub-orgboot-${process.pid}.sqlite`);
  const clean = () => { for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s); };
  let server: any = null; let ctx: any = null;

  async function boot(orgId: string): Promise<string[]> {
    if (server) { await drainApp(server); server = null; }
    if (ctx) { ctx.stopWorkers?.(); await ctx.db.close(); ctx = null; }
    const lines: string[] = [];
    const capture = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    const warn = vi.spyOn(console, 'warn').mockImplementation(capture);
    const err = vi.spyOn(console, 'error').mockImplementation(capture);
    try {
      const out = await createHubApp({ dbPath: DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: orgId } as any);
      server = out.app.listen(0); ctx = out.ctx;
    } finally { log.mockRestore(); warn.mockRestore(); err.mockRestore(); }
    return lines;
  }
  const setPending = (value: string) => ctx.db.run(
    "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('pending_env_orgid', ?, datetime('now'))", [value]);
  const hint = (lines: string[]) => lines.filter(l => /pending/i.test(l) && l.includes('AGENFK_HUB_ORG_ID'));

  beforeEach(async () => { clean(); await boot('org'); });
  afterEach(async () => {
    if (server) await drainApp(server);
    if (ctx) { ctx.stopWorkers?.(); await ctx.db.close(); }
    server = null; ctx = null; clean();
  });

  it('is silent when no rename is pending', async () => {
    expect(hint(await boot('org'))).toEqual([]);
  });

  it('is silent when the env var already carries the pending value', async () => {
    await setPending('org');
    expect(hint(await boot('org'))).toEqual([]);
  });

  it('names the pending value and the variable to set when the env var differs', async () => {
    // Org renamed in the admin UI; the deployment still carries the old AGENFK_HUB_ORG_ID.
    await ctx.db.run("UPDATE orgs SET id = 'renamed-org'");
    await ctx.db.run("UPDATE auth_config SET org_id = 'renamed-org'");
    await setPending('renamed-org');
    const lines = await boot('org');
    const h = hint(lines);
    expect(h.length, lines.join('\n')).toBe(1);
    expect(h[0]).toContain('renamed-org');
    expect(h[0]).toContain('AGENFK_HUB_ORG_ID=renamed-org');
  });

  it('says it before the maintenance page takes over, which is when the operator needs it', async () => {
    await ctx.db.run("UPDATE orgs SET id = 'renamed-org'");
    await setPending('renamed-org');
    const lines = await boot('org');   // no org named "org" any more: the boot guard refuses
    expect(lines.some(l => /BOOT REFUSED/.test(l))).toBe(true);
    expect(hint(lines).length).toBe(1);
  });
});
