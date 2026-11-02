/**
 * @vitest-environment node
 *
 * The remoteUrl a hub event carries follows the project's root (GH-256).
 *
 * The hub keys repo settings and CI receipts on an event's remoteUrl. The
 * server resolves it from `git remote get-url origin` in the project's root
 * and caches the answer per project. Found by the RFC-002 simulation: a
 * project created by `agenfk init` has no root yet, the first event cached
 * "no remote" for good, and setting the root afterwards changed nothing until
 * the server restarted. The same held for a root moved to another repository.
 *
 * Also pins BUG 0bc7669b: the FIRST event for a project already carries the
 * remote (the lookup is awaited, not fired and forgotten).
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The outbox only receives events when the hub is configured, and that config
// is read when ../server is first imported (see pr-registration-api.test.ts).
vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const internal = (r: request.Test) => r.set('x-agenfk-internal', VERIFY_TOKEN!);

const TEST_DB = testDbPath('hub-event-remote-url-test-db.sqlite');
const tmp: string[] = [];

function repoWithOrigin(url: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
  tmp.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
  return dir;
}

beforeAll(async () => {
  __server = app.listen(0);
  process.env.AGENFK_DB_PATH = TEST_DB;
  await removeTestDb(TEST_DB, closeStorage);
  await initStorage();
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// recordHubEvent enqueues a tick after the response; poll for the row.
async function remoteUrlOfCreated(itemId: string): Promise<string | null | undefined> {
  const db: any = (storage as any).database;
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = (db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload))
      .find(p => p.type === 'item.created' && p.itemId === itemId);
    if (found) return found.remoteUrl;
    if (Date.now() >= deadline) return undefined;
    await new Promise(r => setTimeout(r, 25));
  }
}

const newProject = async (name: string) => (await internal(agent().post('/projects')).send({ name })).body.id as string;
const setRoot = (projectId: string, projectRoot: string) =>
  internal(agent().put(`/projects/${projectId}/project-root`)).send({ projectRoot });
const createItem = async (projectId: string) =>
  (await agent().post('/items').send({ projectId, type: 'TASK', title: 'T' })).body.id as string;

describe('the remoteUrl on hub events follows the project root', () => {
  it('the first event for a project already carries its remote', async () => {
    const projectId = await newProject('cold');
    expect((await setRoot(projectId, repoWithOrigin('https://github.com/acme/cold.git'))).status).toBe(200);
    expect(await remoteUrlOfCreated(await createItem(projectId))).toBe('https://github.com/acme/cold.git');
  });

  it('a root set after events were sent is used by the next event', async () => {
    const projectId = await newProject('late-root');
    // `agenfk init` leaves the root unset: this event has no remote to carry.
    expect(await remoteUrlOfCreated(await createItem(projectId))).toBeNull();

    expect((await setRoot(projectId, repoWithOrigin('https://github.com/acme/late.git'))).status).toBe(200);
    expect(await remoteUrlOfCreated(await createItem(projectId))).toBe('https://github.com/acme/late.git');
  });

  it('a root moved to another repository is used by the next event', async () => {
    const projectId = await newProject('moved-root');
    await setRoot(projectId, repoWithOrigin('https://github.com/acme/first.git'));
    expect(await remoteUrlOfCreated(await createItem(projectId))).toBe('https://github.com/acme/first.git');

    await setRoot(projectId, repoWithOrigin('https://github.com/acme/second.git'));
    expect(await remoteUrlOfCreated(await createItem(projectId))).toBe('https://github.com/acme/second.git');
  });
});
