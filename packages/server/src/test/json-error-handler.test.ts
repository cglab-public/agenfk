/**
 * @vitest-environment node
 *
 * BUG 345e0701: an error no route catches must reach the CLI and MCP as JSON.
 *
 * `asyncHandler` forwards a rejected route to `next(err)`. With no error
 * middleware of our own, Express's default handler answered with an HTML page,
 * so the CLI printed "Request failed with status code 500" and MCP got no
 * message at all. The next uncaught throw has to be diagnosable from either.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import { app, initStorage, storage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const TEST_DB = testDbPath('json-error-handler-test-db.sqlite');

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('uncaught route errors', () => {
  it('answer as JSON carrying the error message, with a 500', async () => {
    vi.spyOn(storage, 'listProjects').mockRejectedValue(new Error('the disk is on fire'));
    const res = await agent().get('/projects');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'the disk is on fire' });
  });

  it('never put the stack trace in the body', async () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at secretFrame (/home/someone/server.ts:1:1)';
    vi.spyOn(storage, 'listProjects').mockRejectedValue(err);
    const res = await agent().get('/projects');
    expect(res.text).not.toContain('secretFrame');
    expect(res.text).not.toContain('/home/someone');
  });

  it("keep an error's own HTTP status (a malformed JSON body is the client's fault: 400)", async () => {
    const res = await agent().post('/projects').set('Content-Type', 'application/json').send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('still answer 500 for a thrown non-Error value, with a generic message', async () => {
    vi.spyOn(storage, 'listProjects').mockRejectedValue('a bare string');
    const res = await agent().get('/projects');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe('string');
  });
});
