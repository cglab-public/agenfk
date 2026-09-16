/**
 * @vitest-environment node
 *
 * Settings that belong to the installation, not to a project.
 *
 * These live on the SERVER rather than in `~/.agenfk/config.json`, and that is
 * a deliberate departure from where the CLI keeps `telemetry` and
 * `flowRegistry`. config.json is read and written directly by the CLI, with no
 * server in the path; having the UI write it too would give one value two
 * owners and no arbiter. The database is already one per installation, so a
 * table here is global across projects AND reachable by the CLI, the UI and
 * MCP through the same door.
 *
 * The rules a settings store has to get right are unglamorous and each of them
 * is a real way to lose a user's choice:
 *
 *  - **A missing setting is not a false setting.** Reading a key nobody has
 *    ever written must return the documented default, and writing one key must
 *    not blank the others.
 *  - **Types are checked, not coerced.** The string 'false' is truthy. Coercing
 *    it turns a feature ON for a client that meant to turn it off.
 *  - **Unknown keys are refused.** A store that accepts anything becomes a
 *    junk drawer, and a typo silently writes a setting nothing will ever read.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage } from '../server';

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


const TEST_DB = path.resolve('./app-settings-test-db.sqlite');

describe('installation-wide settings', () => {
  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => { await initStorage(); });

  it('answers with documented defaults before anything has been set', async () => {
    // A fresh install must behave, not 404. Every default here is also a
    // promise that upgrading changes nothing for an existing user.
    const res = await agent().get('/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tmuxByDefault: false });
  });

  it('keeps what it is given', async () => {
    await agent().put('/settings').send({ tmuxByDefault: true });
    expect((await agent().get('/settings')).body.tmuxByDefault).toBe(true);
  });

  it('can be turned back off', async () => {
    await agent().put('/settings').send({ tmuxByDefault: true });
    await agent().put('/settings').send({ tmuxByDefault: false });
    expect((await agent().get('/settings')).body.tmuxByDefault).toBe(false);
  });

  it('returns the whole settled state, so a caller never has to re-read', async () => {
    const res = await agent().put('/settings').send({ tmuxByDefault: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tmuxByDefault: true });
  });

  it('refuses a non-boolean instead of coercing it', async () => {
    // 'false' is a truthy string. Coercion here would switch the feature ON for
    // a client that was trying to switch it off.
    // Set a known value first. These tests share one database file, so
    // asserting "still false" without establishing false is asserting about
    // whatever the previous test happened to leave behind — which is how a
    // test passes for the wrong reason.
    await agent().put('/settings').send({ tmuxByDefault: false });
    const res = await agent().put('/settings').send({ tmuxByDefault: 'false' });
    expect(res.status).toBe(400);
    // The refused write changed nothing, which is the actual claim.
    expect((await agent().get('/settings')).body.tmuxByDefault).toBe(false);
  });

  it('refuses a key it does not know', async () => {
    // Without this the store becomes a junk drawer and a typo writes a setting
    // that nothing will ever read back.
    await agent().put('/settings').send({ tmuxByDefault: false });
    const res = await agent().put('/settings').send({ tmuxByDefualt: true });
    expect(res.status).toBe(400);
    expect((await agent().get('/settings')).body.tmuxByDefault).toBe(false);
    expect(res.body.error).toMatch(/tmuxByDefualt|unknown/i);
  });

  it('refuses an empty write rather than reporting success for nothing', async () => {
    expect((await agent().put('/settings').send({})).status).toBe(400);
  });

  it('does not blank the settings it was not asked about', async () => {
    // The failure this prevents: a client sends one key and silently resets
    // every other preference the user had set.
    await agent().put('/settings').send({ tmuxByDefault: true });
    const before = (await agent().get('/settings')).body;
    await agent().put('/settings').send({ tmuxByDefault: true });
    expect((await agent().get('/settings')).body).toEqual(before);
  });

  it('survives a restart, because a preference that forgets is not one', async () => {
    await agent().put('/settings').send({ tmuxByDefault: true });
    await initStorage();
    expect((await agent().get('/settings')).body.tmuxByDefault).toBe(true);
  });
});

/**
 * The notification settings, checked end to end rather than by reading the type.
 *
 * A field added to `AppSettings` and not to whatever the route destructures is
 * accepted, dropped, and answered with a 200 — the user flips a switch, the
 * screen says it saved, and nothing was written. `PUT /items` did exactly that
 * to `claims` and `externalId` on this repo and nobody noticed for weeks. The
 * route here derives its allowlist from `DEFAULT_APP_SETTINGS`, so it SHOULD be
 * impossible; this is the test that says so out loud, for each field, by
 * writing a non-default value and reading it back through a separate request.
 */
describe('every notification setting survives the round trip', () => {
  beforeEach(async () => { await initStorage(); });

  it('answers a fresh install with every notification default', async () => {
    // A fresh database, so this is the documented default and not a leftover
    // from another test in this file.
    const fresh = path.resolve('./app-settings-notify-defaults.sqlite');
    if (fs.existsSync(fresh)) fs.unlinkSync(fresh);
    const previous = process.env.AGENFK_DB_PATH;
    process.env.AGENFK_DB_PATH = fresh;
    try {
      await initStorage();
      expect((await agent().get('/settings')).body).toMatchObject({
        attentionAlerts: true,
        attentionSound: true,
        soundTiming: 'unfocused',
        osNotifications: true,
      });
    } finally {
      process.env.AGENFK_DB_PATH = previous;
      await initStorage();
      if (fs.existsSync(fresh)) fs.unlinkSync(fresh);
    }
  });

  const cases: ReadonlyArray<[string, unknown]> = [
    ['attentionAlerts', false],
    ['attentionSound', false],
    ['soundTiming', 'always'],
    ['osNotifications', false],
  ];

  for (const [key, value] of cases) {
    it(`stores ${key} and reads it back`, async () => {
      // Read back with a second request, not from the PUT's own response body:
      // a route that echoes its input proves nothing about what was stored.
      const put = await agent().put('/settings').send({ [key]: value });
      expect(put.status, `PUT rejected ${key}`).toBe(200);
      expect((await agent().get('/settings')).body[key]).toEqual(value);
    });
  }

  it('does not lose one notification setting while writing another', async () => {
    await agent().put('/settings').send({ attentionSound: false, soundTiming: 'always' });
    await agent().put('/settings').send({ osNotifications: false });
    const body = (await agent().get('/settings')).body;
    expect(body).toMatchObject({
      attentionSound: false, soundTiming: 'always', osNotifications: false,
    });
  });
});

/**
 * An enum setting, which `typeof` cannot guard.
 *
 * Every store in this repo validates by comparing `typeof value` against the
 * default's type. For `soundTiming` that check passes for any string at all, so
 * 'whenever' is stored, read back, and then falls through the UI's
 * `=== 'always'` test to behave as 'unfocused' — a setting the user chose that
 * silently means something else.
 */
describe('a setting with a fixed set of legal values', () => {
  beforeEach(async () => { await initStorage(); });

  it('accepts both documented timings', async () => {
    expect((await agent().put('/settings').send({ soundTiming: 'always' })).status).toBe(200);
    expect((await agent().put('/settings').send({ soundTiming: 'unfocused' })).status).toBe(200);
  });

  it('refuses a string that is not one of them, and stores nothing', async () => {
    await agent().put('/settings').send({ soundTiming: 'unfocused' });
    const res = await agent().put('/settings').send({ soundTiming: 'whenever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/soundTiming/);
    expect((await agent().get('/settings')).body.soundTiming).toBe('unfocused');
  });

  it('refuses it inside an otherwise valid write, rather than applying half', async () => {
    // The transaction in storage is per-write, so a route that validated one
    // key and then wrote the batch would land the good half of a rejected
    // request — the user gets a partial state they never chose.
    await agent().put('/settings').send({ attentionSound: true, soundTiming: 'unfocused' });
    const res = await agent().put('/settings').send({ attentionSound: false, soundTiming: 'nope' });
    expect(res.status).toBe(400);
    const body = (await agent().get('/settings')).body;
    expect(body.attentionSound).toBe(true);
    expect(body.soundTiming).toBe('unfocused');
  });
});

describe('what settings deliberately do NOT hold', () => {
  beforeEach(async () => { await initStorage(); });

  it('is not where auto-approve lives, and refuses it outright', async () => {
    // It was here for one commit. An adversarial review pointed out what that
    // meant: this route is unauthenticated and accepts requests with no Origin
    // header, while the setting changes the argv of every agent spawned
    // afterwards — the same class as verifyCommand, which has sat behind
    // VERIFY_TOKEN in this server precisely for that reason.
    //
    // The escalation that matters here: an agent running WITH prompts on,
    // granted approval for one localhost call, could permanently remove the
    // prompts for every future session. It now lives in the desktop app behind
    // the preload IPC, where no HTTP route reaches it at all — see
    // packages/desktop/src/main/prefs.ts.
    const res = await agent().put('/settings').send({ autoApproveByDefault: true });
    expect(res.status).toBe(400);
    expect((await agent().get('/settings'))).not.toHaveProperty('body.autoApproveByDefault');
  });

  it('is not where a project keeps its worktree preference', async () => {
    // autoWorktree stays on the project, where it already lives and already has
    // data. Moving it would be a migration nobody asked for, and having it in
    // both places would give one value two sources of truth.
    expect((await agent().get('/settings')).body).not.toHaveProperty('autoWorktree');
  });
});

describe('the project route no longer carries the tmux preference', () => {
  beforeEach(async () => { await initStorage(); });

  it('rejects tmuxByDefault on a project', async () => {
    // It was project-scoped for one commit and the decision changed to global.
    // Leaving the old route working would give the same preference two homes,
    // which is worse than either home alone: whichever one the UI reads, the
    // other silently disagrees.
    const p = await agent().post('/projects').send({ name: 'no-tmux-here' });
    const res = await agent().put(`/projects/${p.body.id}`).send({ tmuxByDefault: true });
    expect(res.status).toBe(400);
  });
});
