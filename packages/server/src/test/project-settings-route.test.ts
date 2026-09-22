/**
 * The configuration of a project, with the origin of every value.
 *
 * The rules live in core and are tested there; what a route can get wrong is
 * tested here — the status codes, the shape, and the promise that reading this
 * changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, initStorage } from '../server';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = path.resolve('./project-settings-route-test-db.sqlite');
let server: import('http').Server;
let projectId: string;

beforeAll(async () => {
  process.env.AGENFK_DB_PATH = TEST_DB;
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await initStorage();
  server = app.listen(0);
  const created = await request(server).post('/projects').send({ name: 'horizon-ds' });
  projectId = created.body.id;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

it('answers with a row per setting, each carrying its origin', async () => {
  const res = await request(server).get(`/projects/${projectId}/settings`);
  expect(res.status).toBe(200);
  const keys = res.body.rows.map((r: any) => r.key).sort();
  expect(keys).toEqual(
    ['autoWorktree', 'flow', 'projectRoot', 'setupCommand', 'verifyCommand', 'worktreeRoot'].sort(),
  );
  for (const row of res.body.rows) expect(row.origin).toBeTruthy();
});

it('names the flow in force, rather than leaving the row blank', async () => {
  // A project that has chosen no flow still runs one. "Blank, inherited" makes
  // the reader go looking for which.
  const res = await request(server).get(`/projects/${projectId}/settings`);
  const flow = res.body.rows.find((r: any) => r.key === 'flow');
  expect(flow.origin).toBe('inherited');
  expect(flow.value).toBeTruthy();
});

it('says what a missing setup command costs', async () => {
  const res = await request(server).get(`/projects/${projectId}/settings`);
  const setup = res.body.rows.find((r: any) => r.key === 'setupCommand');
  expect(setup.value).toBeNull();
  expect(setup.warning).toMatch(/dependencies/i);
  // And the command that fixes it, since the screen may not.
  expect(setup.how).toMatch(/agenfk update-project/);
});

it('404s for a project that is not there', async () => {
  const res = await request(server).get('/projects/nope/settings');
  expect(res.status).toBe(404);
});

// Reading configuration must not write any.
it('changes nothing', async () => {
  const before = await request(server).get(`/projects/${projectId}`);
  await request(server).get(`/projects/${projectId}/settings`);
  const after = await request(server).get(`/projects/${projectId}`);
  expect(after.body).toEqual(before.body);
});
