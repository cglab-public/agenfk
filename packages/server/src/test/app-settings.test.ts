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
    const res = await request(app).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tmuxByDefault: false, autoApproveByDefault: false });
  });

  it('keeps what it is given', async () => {
    await request(app).put('/settings').send({ tmuxByDefault: true });
    expect((await request(app).get('/settings')).body.tmuxByDefault).toBe(true);
  });

  it('can be turned back off', async () => {
    await request(app).put('/settings').send({ tmuxByDefault: true });
    await request(app).put('/settings').send({ tmuxByDefault: false });
    expect((await request(app).get('/settings')).body.tmuxByDefault).toBe(false);
  });

  it('returns the whole settled state, so a caller never has to re-read', async () => {
    const res = await request(app).put('/settings').send({ tmuxByDefault: true });
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
    await request(app).put('/settings').send({ tmuxByDefault: false });
    const res = await request(app).put('/settings').send({ tmuxByDefault: 'false' });
    expect(res.status).toBe(400);
    // The refused write changed nothing, which is the actual claim.
    expect((await request(app).get('/settings')).body.tmuxByDefault).toBe(false);
  });

  it('refuses a key it does not know', async () => {
    // Without this the store becomes a junk drawer and a typo writes a setting
    // that nothing will ever read back.
    await request(app).put('/settings').send({ tmuxByDefault: false });
    const res = await request(app).put('/settings').send({ tmuxByDefualt: true });
    expect(res.status).toBe(400);
    expect((await request(app).get('/settings')).body.tmuxByDefault).toBe(false);
    expect(res.body.error).toMatch(/tmuxByDefualt|unknown/i);
  });

  it('refuses an empty write rather than reporting success for nothing', async () => {
    expect((await request(app).put('/settings').send({})).status).toBe(400);
  });

  it('does not blank the settings it was not asked about', async () => {
    // The failure this prevents: a client sends one key and silently resets
    // every other preference the user had set.
    await request(app).put('/settings').send({ tmuxByDefault: true });
    const before = (await request(app).get('/settings')).body;
    await request(app).put('/settings').send({ tmuxByDefault: true });
    expect((await request(app).get('/settings')).body).toEqual(before);
  });

  it('survives a restart, because a preference that forgets is not one', async () => {
    await request(app).put('/settings').send({ tmuxByDefault: true });
    await initStorage();
    expect((await request(app).get('/settings')).body.tmuxByDefault).toBe(true);
  });
});

describe('what settings deliberately do NOT hold', () => {
  beforeEach(async () => { await initStorage(); });

  it('holds auto-approve, but never on by default', async () => {
    // It was refused here on purpose until the user asked for the terminal
    // dialog to stop asking, which left it nowhere else to live. What survives
    // that move is the DEFAULT: a fresh install, and every existing one, still
    // starts agents with their permission prompts intact. The setting can only
    // become true because somebody went and turned it on.
    expect((await request(app).get('/settings')).body.autoApproveByDefault).toBe(false);
    const res = await request(app).put('/settings').send({ autoApproveByDefault: true });
    expect(res.status).toBe(200);
    expect(res.body.autoApproveByDefault).toBe(true);
  });

  it('refuses a non-boolean auto-approve, like every other setting', async () => {
    // The setting that can cost the most gets the same guard as the rest: a
    // truthy string must not be able to take the rails off.
    await request(app).put('/settings').send({ autoApproveByDefault: false });
    expect((await request(app).put('/settings').send({ autoApproveByDefault: 'yes' })).status).toBe(400);
    expect((await request(app).get('/settings')).body.autoApproveByDefault).toBe(false);
  });

  it('is not where a project keeps its worktree preference', async () => {
    // autoWorktree stays on the project, where it already lives and already has
    // data. Moving it would be a migration nobody asked for, and having it in
    // both places would give one value two sources of truth.
    expect((await request(app).get('/settings')).body).not.toHaveProperty('autoWorktree');
  });
});

describe('the project route no longer carries the tmux preference', () => {
  beforeEach(async () => { await initStorage(); });

  it('rejects tmuxByDefault on a project', async () => {
    // It was project-scoped for one commit and the decision changed to global.
    // Leaving the old route working would give the same preference two homes,
    // which is worse than either home alone: whichever one the UI reads, the
    // other silently disagrees.
    const p = await request(app).post('/projects').send({ name: 'no-tmux-here' });
    const res = await request(app).put(`/projects/${p.body.id}`).send({ tmuxByDefault: true });
    expect(res.status).toBe(400);
  });
});
