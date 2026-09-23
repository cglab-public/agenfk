/**
 * /setup/initial-admin: the bootstrap token makes exactly ONE admin.
 *
 * The route already closes after first use (409 once a user exists, token
 * deleted). But "no users yet" was checked outside the transaction and the
 * DELETE never confirmed it consumed anything, so two simultaneous requests
 * carrying the token could both pass and create two admins. The token is now
 * consumed inside the transaction, and a request that did not consume it
 * creates nothing. The route is also rate limited.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp, openHubDb } from '../server';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-initadmin-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

describe('/setup/initial-admin', () => {
  let app: any; let ctx: any; let server: import('http').Server; let token: string;
  const setup = (email: string, t = token, ip = '198.51.100.1') => supertest(server)
    .post('/setup/initial-admin').set('X-Forwarded-For', ip).send({ token: t, email, password: 'longenough1' });

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    server = app.listen(0);
    token = (await ctx.db.get('SELECT token FROM bootstrap_tokens LIMIT 1')).token;
  });
  afterEach(async () => {
    ctx.stopWorkers?.(); await drainApp(server); await new Promise<void>(r => server.close(() => r()));
    await ctx.db.close(); cleanup();
  });

  it('creates nothing when another request consumed the token after this one read it', async () => {
    // The race, made deterministic: right after this request reads the token,
    // a concurrent request consumes it (simulated by deleting the row). On
    // Postgres that interleaving is real; the loser must not create an admin.
    await drainApp(server); await new Promise<void>(r => server.close(() => r())); await ctx.db.close(); cleanup();
    const real: any = await openHubDb({ dbPath: DB });
    let armed = false;
    const racing = new Proxy(real, {
      get(t, prop) {
        if (prop === 'get') {
          return async (sql: string, params?: unknown[]) => {
            const row = await t.get(sql, params);
            if (armed && /FROM bootstrap_tokens/.test(sql)) { armed = false; await t.run('DELETE FROM bootstrap_tokens', []); }
            return row;
          };
        }
        const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org', db: racing });
    app = out.app; ctx = out.ctx; server = app.listen(0);
    token = (await real.get('SELECT token FROM bootstrap_tokens LIMIT 1')).token;
    armed = true;

    const r = await setup('late@x');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(await real.all('SELECT email FROM users')).toHaveLength(0);
  });

  it('clears every bootstrap token on success, not only the one it used', async () => {
    // Two hub tasks booting together on an empty database can each insert a
    // token. A leftover second token is a second key to an admin account for
    // any request that passed the "no users yet" check before the first commit.
    await ctx.db.run('INSERT INTO bootstrap_tokens (token) VALUES (?)', ['second-token']);
    expect((await setup('a@x')).status).toBe(201);
    expect(await ctx.db.all('SELECT token FROM bootstrap_tokens')).toHaveLength(0);
  });

  it('is closed after use: the same token cannot make a second admin', async () => {
    expect((await setup('a@x')).status).toBe(201);
    expect((await setup('b@x')).status).toBe(409);
    expect(await ctx.db.all('SELECT email FROM users')).toHaveLength(1);
  });

  it('answers 429 once one client has spent its budget', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await setup('a@x', 'wrong-token', '198.51.100.7');
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    expect((await setup('a@x', 'wrong-token', '198.51.100.7')).status).toBe(429);
    // Another client, holding the real token, is not locked out by the first.
    expect((await setup('ops@x', token, '198.51.100.8')).status).toBe(201);
  });
});
