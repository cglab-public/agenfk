/**
 * @file GitHub #208 phase 4 review — the pane routes only talk to a live herdr.
 *
 * `/herdr/panes/:id/{content,text,keys,focus}` take the socket from the caller.
 * The board sends one discovery handed it, but nothing checked that: any local
 * socket path - and on Windows, where a socket path names `\\.\pipe\<path>`,
 * any string - reached the transport. A socket discovery does not list is now
 * refused before a byte is sent.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_DB = testDbPath('herdr-pane-routes-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage } from '../server';
import { HERDR_SOCKET_FILE } from '../herdr';

let __server: import('http').Server;
const agent = () => request(__server);
const savedSocket = process.env.HERDR_SOCKET_PATH;
let root = '';
let live = '';

beforeAll(async () => {
  // A config root whose default session's socket file exists (herdr writes a
  // marker there on Windows): discovery lists it, nothing listens on it.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-herdr-routes-'));
  live = path.join(root, HERDR_SOCKET_FILE);
  fs.writeFileSync(live, '');
  process.env.HERDR_SOCKET_PATH = live;
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  if (savedSocket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = savedSocket;
  await removeTestDb(TEST_DB, closeStorage);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const elsewhere = () => path.join(os.tmpdir(), 'not-a-herdr-session', HERDR_SOCKET_FILE);

describe('the herdr pane routes', () => {
  it('refuse a socket discovery does not list, on every route', async () => {
    const bad = elsewhere();
    const replies = await Promise.all([
      agent().get('/herdr/panes/p1/content').query({ socket: bad }),
      agent().post('/herdr/panes/p1/text').send({ socket: bad, text: 'x' }),
      agent().post('/herdr/panes/p1/keys').send({ socket: bad, keys: ['Enter'] }),
      agent().post('/herdr/panes/p1/focus').send({ socket: bad }),
    ]);
    for (const r of replies) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toMatch(/not a live herdr session/);
    }
  });

  it('refuse a bare name, which on Windows would name a pipe of its own', async () => {
    const r = await agent().post('/herdr/panes/p1/focus').send({ socket: 'herdr.sock' });
    expect(r.status).toBe(400);
  });

  it('let a listed session through to the transport', async () => {
    // Nothing listens, so the transport fails: a 502 from herdr's side, not the 400 of a refusal.
    const r = await agent().post('/herdr/panes/p1/focus').send({ socket: live });
    expect(r.status, JSON.stringify(r.body)).toBe(502);
  });
});
