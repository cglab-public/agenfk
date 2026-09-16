/**
 * @vitest-environment node
 *
 * The routes the Settings screen actually calls.
 *
 * `githubAccount.test.ts` and `setTelemetryEnabled.test.ts` prove the logic.
 * This file proves something different and, on this branch, more valuable:
 * that the logic is REACHABLE. A module that is correct, unit-tested and
 * wired to no route is the failure this branch keeps producing — the code
 * looks finished because every test it has is green.
 *
 * So the assertions here are deliberately shallow and the coverage is
 * deliberately broad: every endpoint the screen calls answers, with the shape
 * the screen reads.
 *
 * The one thing NOT exercised end to end is a successful `gh auth logout`.
 * It would log the developer running the suite out of their own GitHub CLI.
 * What is exercised is the guard in front of it, which is the part with a
 * security claim attached.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';
import { isTelemetryEnabled } from '@agenfk/telemetry';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => {
  __server = app.listen(0);
  process.env.AGENFK_DB_PATH = path.resolve('./settings-routes-test-db.sqlite');
  await initStorage();
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  const db = path.resolve('./settings-routes-test-db.sqlite');
  if (fs.existsSync(db)) fs.unlinkSync(db);
});

describe('GET /github/account', () => {
  it('answers, whether or not this machine has gh at all', async () => {
    // The point of the test. CI has no authenticated gh, so the only honest
    // assertion is the SHAPE — and the shape is what proves the route exists,
    // is mounted, and does not throw its way into a 500 on the machine where
    // gh is missing, which is every machine in CI.
    const res = await agent().get('/github/account').set('x-agenfk-ui', '1');
    expect(res.status).toBe(200);
    expect(typeof res.body.connected).toBe('boolean');
  });

  it('says why when it is not connected, rather than just false', async () => {
    // "Not connected" with no reason leaves the screen unable to choose between
    // "install the GitHub CLI" and "run gh auth login", which are different
    // instructions and only one of them is useful.
    const res = await agent().get('/github/account').set('x-agenfk-ui', '1');
    if (res.body.connected === false) {
      expect(res.body.reason).toMatch(/gh_missing|not_authenticated|unreadable/);
    } else {
      expect(typeof res.body.login).toBe('string');
    }
  });

  it('refuses a request that did not come from the app', async () => {
    /*
     * Unusual for a GET, and the reason is that a simple GET is not gated by
     * CORS: a foreign origin cannot READ the response, but the request is still
     * issued and the `gh` process still runs. Without this, any page the user
     * visits can drive an eight-second synchronous exec in a loop on a
     * single-threaded server - and read back a login, a name and an email.
     */
    expect((await agent().get('/github/account')).status).toBe(403);
  });

  it('takes no projectId, because an account is not project-scoped', async () => {
    // GET /github/status is per project — it answers which repo a card maps to.
    // Conflating the two is how the screen ends up saying "not connected"
    // because no project has a repo configured.
    expect((await agent().get('/github/account').set('x-agenfk-ui', '1')).status).toBe(200);
  });
});

describe('POST /github/signout', () => {
  it('refuses a request that did not come from the app', async () => {
    // Same guard as POST /releases/update, for the same reason: this server is
    // unauthenticated on loopback and its CORS allowlist trusts any localhost
    // origin. Requiring a custom header forces a preflight, which a page from
    // another origin cannot pass. Without it, any tab open on the machine can
    // log the user out of their GitHub CLI.
    const res = await agent().post('/github/signout');
    expect(res.status).toBe(403);
  });

  it('names the header instead of failing blankly', async () => {
    const res = await agent().post('/github/signout');
    expect(JSON.stringify(res.body)).toMatch(/x-agenfk-ui|not allowed|forbidden/i);
  });
});

describe('the telemetry choice', () => {
  it('is readable', async () => {
    const res = await agent().get('/api/telemetry/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.telemetryEnabled).toBe('boolean');
  });

  it('is writable, and the read reflects it', async () => {
    // HOME is pinned to a per-run sandbox by the vitest config, so this writes
    // a throwaway ~/.agenfk/config.json and not the developer's.
    const res = await agent()
      .put('/api/telemetry/config')
      .set('x-agenfk-ui', '1')
      .send({ telemetryEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.telemetryEnabled).toBe(false);
    // Read back through the reader the rest of the server uses, not through the
    // response body — an echo proves nothing about what was stored.
    expect(isTelemetryEnabled()).toBe(false);
    expect((await agent().get('/api/telemetry/config')).body.telemetryEnabled).toBe(false);
  });

  it('can be turned back on', async () => {
    await agent().put('/api/telemetry/config').set('x-agenfk-ui', '1').send({ telemetryEnabled: false });
    await agent().put('/api/telemetry/config').set('x-agenfk-ui', '1').send({ telemetryEnabled: true });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('refuses a write that did not come from the app', async () => {
    // Opting somebody IN to analytics is a privacy decision, and this route is
    // reachable by any page on the machine. The read stays open; the write does
    // not.
    await agent().put('/api/telemetry/config').set('x-agenfk-ui', '1').send({ telemetryEnabled: false });
    const res = await agent().put('/api/telemetry/config').send({ telemetryEnabled: true });
    expect(res.status).toBe(403);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('refuses a non-boolean instead of coercing it', async () => {
    // 'false' is truthy. Coercing it opts a user in who was opting out.
    await agent().put('/api/telemetry/config').set('x-agenfk-ui', '1').send({ telemetryEnabled: true });
    const res = await agent()
      .put('/api/telemetry/config')
      .set('x-agenfk-ui', '1')
      .send({ telemetryEnabled: 'false' });
    expect(res.status).toBe(400);
    expect(isTelemetryEnabled()).toBe(true);
  });
});
