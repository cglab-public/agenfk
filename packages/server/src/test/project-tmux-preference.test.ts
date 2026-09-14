/**
 * @vitest-environment node
 *
 * Whether a project's terminals run inside tmux.
 *
 * Off by default, and stored rather than inferred. Three reasons, in order of
 * how much they cost if ignored:
 *
 *  - Running the agent inside tmux changes the terminal it lives in. The tmux
 *    prefix (C-b) starts competing with the agent's own shortcuts, and nothing
 *    warns the user that their keys now mean something else. That is a change
 *    a person should opt into, not discover.
 *  - Sessions that predate the feature kept working without it. Turning it on
 *    for everyone who upgrades changes behaviour nobody asked to change.
 *  - The preference is a decision, and capability is a fact about the machine.
 *    They are stored separately on purpose: the value is PRESERVED where tmux
 *    cannot run, so opening the same project on Windows does not silently erase
 *    a choice made on a Mac.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, VERIFY_TOKEN } from '../server';

const TEST_DB = path.resolve('./project-tmux-test-db.sqlite');
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

describe('a project\'s tmux preference', () => {
  let projectId: string;

  beforeAll(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initStorage();
  });
  afterAll(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  beforeEach(async () => {
    await initStorage();
    const p = await internal(request(app).post('/projects')).send({ name: 'tmux-pref' });
    projectId = p.body.id;
  });

  it('is off for a project that never set it', async () => {
    // Upgrading must not change how anyone's terminals behave.
    const res = await request(app).get(`/projects/${projectId}`);
    expect(res.body.tmuxByDefault ?? false).toBe(false);
  });

  it('can be turned on and comes back on', async () => {
    await internal(request(app).put(`/projects/${projectId}`)).send({ tmuxByDefault: true });
    expect((await request(app).get(`/projects/${projectId}`)).body.tmuxByDefault).toBe(true);
  });

  it('can be turned off again', async () => {
    await internal(request(app).put(`/projects/${projectId}`)).send({ tmuxByDefault: true });
    await internal(request(app).put(`/projects/${projectId}`)).send({ tmuxByDefault: false });
    expect((await request(app).get(`/projects/${projectId}`)).body.tmuxByDefault).toBe(false);
  });

  it('ignores a non-boolean rather than coercing it', async () => {
    // 'false' is a truthy string. Coercing here would turn the setting on for
    // a client that meant to turn it off.
    await internal(request(app).put(`/projects/${projectId}`)).send({ tmuxByDefault: 'false' });
    expect((await request(app).get(`/projects/${projectId}`)).body.tmuxByDefault ?? false).toBe(false);
  });

  it('survives an unrelated update', async () => {
    await internal(request(app).put(`/projects/${projectId}`)).send({ tmuxByDefault: true });
    await internal(request(app).put(`/projects/${projectId}`)).send({ name: 'renamed' });
    const after = await request(app).get(`/projects/${projectId}`);
    expect(after.body.tmuxByDefault).toBe(true);
    expect(after.body.name).toBe('renamed');
  });

  it('is stored even though the server cannot know whether tmux exists', async () => {
    // Deliberate separation. The preference is the user's decision; whether
    // tmux is installed is a fact about one machine. Storing only the
    // intersection would erase a Mac choice the moment the project is opened
    // on Windows, where tmux cannot exist at all.
    await internal(request(app).put(`/projects/${projectId}`)).send({ tmuxByDefault: true });
    const stored = await request(app).get(`/projects/${projectId}`);
    expect(stored.body.tmuxByDefault).toBe(true);
    expect(stored.body).not.toHaveProperty('tmuxAvailable');
  });
});
