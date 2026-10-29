/**
 * BUG 3afbbf7e: inside the Airlock sandbox the gatekeeper could not record which card its
 * session works on - ~/.agenfk is unwritable there - so the dataset joined no live call to its
 * card. The sandboxed CLI hands the note to the server, which writes it outside the sandbox:
 * POST /active-work { itemId, sessionId }. The note is keyed to the session, the same file the
 * run recorder and Airlock read.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, initStorage, closeStorage } from '../server';
import { readActiveWorkForSession, activeWorkPath } from '../agent-runs/activeWork';

const TEST_DB = testDbPath('active-work-route-test-db.sqlite');
let __server: import('http').Server;
const agent = () => request(__server);
let seq = 0;

const wipe = (): void => {
  try { fs.rmSync(activeWorkPath(), { force: true }); } catch { /* nothing there */ }
  try { fs.rmSync(path.join(os.homedir(), '.agenfk', 'active-work'), { recursive: true, force: true }); } catch { /* nothing there */ }
};

async function card(): Promise<{ id: string; projectId: string }> {
  const p = await agent().post('/projects').send({ name: `aw-${++seq}` });
  const c = await agent().post('/items').send({ type: 'TASK', title: `aw-${++seq}`, projectId: p.body.id });
  return { id: c.body.id, projectId: p.body.id };
}

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  await removeTestDb(TEST_DB, closeStorage);
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, closeStorage);
});
afterEach(wipe);

describe('POST /active-work', () => {
  it('records the card for the session, where the recorder reads it', async () => {
    const c = await card();
    const res = await agent().post('/active-work').send({ itemId: c.id, sessionId: 'pi-sess-1' });
    expect(res.status).toBe(204);
    expect(readActiveWorkForSession('pi-sess-1')).toEqual({ itemId: c.id, projectId: c.projectId });
    // keyed: no other session, and not the shared note
    expect(readActiveWorkForSession('pi-sess-2')).toBeNull();
    expect(fs.existsSync(activeWorkPath())).toBe(false);
  });

  it('needs a session: a shared note from a sandbox would capture every other session', async () => {
    const c = await card();
    const res = await agent().post('/active-work').send({ itemId: c.id });
    expect(res.status).toBe(400);
    expect(fs.existsSync(activeWorkPath())).toBe(false);
  });

  it('refuses a card that does not exist, and a session id it would have to shorten', async () => {
    expect((await agent().post('/active-work').send({ itemId: 'no-such-card', sessionId: 's' })).status).toBe(404);
    const c = await card();
    expect((await agent().post('/active-work').send({ itemId: c.id, sessionId: 'x'.repeat(257) })).status).toBe(400);
  });
});

// Review finding S3: the coverage middleware confines the CARD to the sandbox's project, but the
// session id is the caller's word - a sandbox could overwrite another session's note and take
// its attribution. A sandbox's note is keyed under its signed launch, so it can only ever be
// read back for calls that same launch makes.
describe('POST /active-work from an Airlock sandbox (review finding S3)', () => {
  it('a marked request writes under its launch, never another session\'s plain note', async () => {
    const { sandboxSessionKey } = await import('../agent-runs/activeWork');
    const c = await card();
    // what the coverage middleware sets on a request carrying a verified marker
    const outer = express();
    outer.use(express.json());
    outer.use((req: any, _res, next) => { req.airlockSession = 'launch-nonce-1'; next(); });
    outer.use(app);
    const srv = outer.listen(0);
    try {
      const res = await request(srv).post('/active-work').send({ itemId: c.id, sessionId: 'victim-session' });
      expect(res.status).toBe(204);
      expect(readActiveWorkForSession('victim-session')).toBeNull();
      expect(readActiveWorkForSession(sandboxSessionKey('launch-nonce-1', 'victim-session'))).toEqual({ itemId: c.id, projectId: c.projectId });
    } finally {
      await new Promise<void>(r => srv.close(() => r()));
    }
  });

  it('the key of one launch is not another launch\'s', async () => {
    const { sandboxSessionKey } = await import('../agent-runs/activeWork');
    expect(sandboxSessionKey('a', 's')).not.toBe(sandboxSessionKey('b', 's'));
    expect(sandboxSessionKey('a', 's')).not.toBe('s');
  });
});

// Second review: the launch nonce with a long session id passed the 255-byte file-name limit,
// and the note was lost while the route answered 204.
describe('a sandbox note with a long session id (second review)', () => {
  it('is written and read back under a key of fixed length', async () => {
    const { sandboxSessionKey } = await import('../agent-runs/activeWork');
    const nonce = `${'n'.repeat(32)}.${'a8873a97-e117-4088-87c9-26aca48c7c84'}`; // a launch nonce's length (70)
    const session = 's'.repeat(256);
    expect(sandboxSessionKey(nonce, session).length).toBeLessThanOrEqual(64);
    const c = await card();
    const outer = express();
    outer.use(express.json());
    outer.use((req: any, _res, next) => { req.airlockSession = nonce; next(); });
    outer.use(app);
    const srv = outer.listen(0);
    try {
      expect((await request(srv).post('/active-work').send({ itemId: c.id, sessionId: session })).status).toBe(204);
      expect(readActiveWorkForSession(sandboxSessionKey(nonce, session))).toEqual({ itemId: c.id, projectId: c.projectId });
    } finally {
      await new Promise<void>(r => srv.close(() => r()));
    }
  });
});
