/**
 * POST /hub/invite/redeem is rate limited (CodeQL #114, js/missing-rate-limiting).
 *
 * Redeeming verifies an HMAC-signed invite and mints an installation's bearer
 * token, and it takes no session: anyone who can reach the hub can call it.
 * Nothing bounded it - the router-level limiters it was assumed to sit behind
 * belong to other routers.
 *
 * Only FAILED redemptions spend the budget. Each invite works once, so a
 * successful redeem is already capped by how many invites the admin made, and
 * a scripted rollout of many machines behind one office NAT must not be cut
 * off halfway through by its own success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';

const verifySpy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../auth/inviteToken', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    verifyInviteToken: (token: string, ...rest: any[]) => {
      verifySpy.calls.push(token);
      return real.verifyInviteToken(token, ...rest);
    },
  };
});

import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { drainApp } from './helpers/drainApp';

const DB = path.join(os.tmpdir(), `agenfk-hub-redeem-limit-${process.pid}.sqlite`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (fs.existsSync(f)) fs.unlinkSync(f); } };

describe('POST /hub/invite/redeem rate limit', () => {
  let app: any; let ctx: any; let server: import('http').Server;
  // One listening server per test: a fresh ephemeral server per request is
  // the loopback churn behind the suite's ECONNRESET flake.
  const agent = () => supertest(server);
  const redeemFrom = (ip: string, inviteToken: string) =>
    agent().post('/hub/invite/redeem').set('X-Forwarded-For', ip).send({ inviteToken });

  beforeEach(async () => {
    cleanup();
    verifySpy.calls.length = 0;
    const out = await createHubApp({ dbPath: DB, secretKey: 'a'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    server = app.listen(0);
  });
  afterEach(async () => {
    ctx.stopWorkers?.(); await drainApp(server); await new Promise<void>(r => server.close(() => r()));
    await ctx.db.close(); cleanup();
  });

  it('answers 429 once one client has spent its budget of failed redemptions', async () => {
    for (let i = 0; i < 60; i++) {
      const r = await redeemFrom('198.51.100.9', 'not-a-real-token');
      expect(r.status, `request ${i + 1} was limited early`).toBe(400);
    }
    const over = await redeemFrom('198.51.100.9', 'not-a-real-token');
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/invite/i);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keeps separate clients apart', async () => {
    for (let i = 0; i < 60; i++) await redeemFrom('198.51.100.9', 'x');
    expect((await redeemFrom('198.51.100.9', 'x')).status).toBe(429);
    expect((await redeemFrom('198.51.100.10', 'x')).status).toBe(400);
  });

  it('does not count successful redemptions: a 65-machine rollout behind one NAT completes', async () => {
    await createPasswordUser(ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const cookie = (await agent().post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    for (let i = 0; i < 65; i++) {
      const inv = await agent().post('/hub/invite/create').set('Cookie', cookie).send({});
      expect(inv.status).toBe(200);
      const r = await redeemFrom('203.0.113.50', inv.body.inviteToken);
      expect(r.status, `machine ${i + 1} was refused`).toBe(200);
    }
  });

  it('refuses an oversized token before verifying its signature', async () => {
    const r = await redeemFrom('198.51.100.20', 'a'.repeat(5000));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid invite token');
    expect(verifySpy.calls.some(t => t.length > 4096), 'a 5000-char token was HMAC-verified').toBe(false);
    // The spy is wired: a short invalid token IS verified. Without this, a mock
    // that silently stopped applying would pass the assertion above.
    await redeemFrom('198.51.100.20', 'short-invalid');
    expect(verifySpy.calls).toEqual(['short-invalid']);
  });
});
