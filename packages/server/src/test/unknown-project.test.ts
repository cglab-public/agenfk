/**
 * BUG f36c8a42 (CGLAB-434): a card under a project that does not exist.
 *
 * `agenfk create TASK "x" --project undefined` (a script read the wrong JSON
 * field) used to answer 201 and store a card under projectId 'undefined'.
 * Every `agenfk verify` on it then answered a bare 500: the CLI always sends
 * its cwd, and validate's root-learning branch called updateProject on the
 * missing project, which throws - the error handler turned that into `{}`.
 *
 * Contract under test:
 *  - POST /items and the JIRA/GitHub imports refuse an unknown projectId with
 *    404 naming it, and store nothing.
 *  - validate on a card whose project is gone (created before this fix, or
 *    by any path that skipped the check) answers a clear 4xx naming the
 *    project and the way out (409, like the handler's other refusals of a
 *    card's state), with or without a cwd - never a 500.
 *  - A non-string projectId is a 400, not a 500.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const TEST_DB = testDbPath('unknown-project-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, VERIFY_TOKEN, storage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/**
 * A directory validate's root-learning accepts as a project root: a `.agenfk`
 * marker in a git repository's main checkout. Without the fix, a verify from
 * here reaches updateProject on the missing project - the original 500. The
 * repo's own checkout is no stand-in: `.agenfk/` is untracked, so CI has none.
 */
const madeDirs: string[] = [];
afterAll(() => { for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true }); });
function markedProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-orphan-'));
  madeDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.agenfk'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** A card stored under a project id no project has - the state the old create left behind. */
async function orphanCard(id: string, projectId: string) {
  await storage.createItem({
    id, projectId, type: 'TASK', title: 'orphan', status: 'TODO',
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
}

describe('BUG f36c8a42: cards under a project that does not exist', () => {
  beforeEach(async () => { await initStorage(); });

  it('POST /items refuses an unknown projectId with 404 naming it, and stores nothing', async () => {
    const res = await agent().post('/items').send({ type: 'TASK', title: 'x', projectId: 'undefined' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Project undefined not found');
    const stored = await storage.listItems({ projectId: 'undefined' } as any);
    expect(stored).toHaveLength(0);
  });

  it('POST /items still creates a card under a project that exists', async () => {
    const project = await agent().post('/projects').send({ name: 'UP-real' });
    expect(project.status).toBe(201);

    const res = await agent().post('/items').send({ type: 'TASK', title: 'x', projectId: project.body.id });

    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(project.body.id);
  });

  it('validate WITH a cwd (as the CLI sends) on an orphaned card answers a clear 409, not a 500', async () => {
    await orphanCard('orphan-cwd', 'gone-project');
    const cwd = markedProjectDir();

    const res = await agent().post('/items/orphan-cwd/validate')
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'e', cwd });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('gone-project');
    expect(res.body.error).toContain('agenfk move orphan-cwd');
  });

  it('validate WITHOUT a cwd on an orphaned card answers the same clear 409', async () => {
    await orphanCard('orphan-nocwd', 'gone-project');

    const res = await agent().post('/items/orphan-nocwd/validate')
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'e' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('gone-project');
    expect(res.body.error).toContain('agenfk move orphan-nocwd');
  });

  it('the orphaned card does not move', async () => {
    await orphanCard('orphan-stays', 'gone-project');

    const res = await agent().post('/items/orphan-stays/validate')
      .set('x-agenfk-internal', VERIFY_TOKEN!)
      .send({ evidence: 'e' });

    expect(res.status).toBe(409);
    expect((await storage.getItem('orphan-stays'))?.status).toBe('TODO');
  });

  it('POST /items refuses a projectId that is not a string with 400, not a 500', async () => {
    const res = await agent().post('/items').send({ type: 'TASK', title: 'x', projectId: { $ne: null } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ProjectId must be a string');
  });

  it('POST /github/import refuses a projectId no project has with 404', async () => {
    const res = await agent().post('/github/import')
      .send({ projectId: 'no-such-project', items: [{ issueNumber: 1, type: 'TASK' }] });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Project no-such-project not found');
    expect(await storage.listItems({ projectId: 'no-such-project' } as any)).toHaveLength(0);
  });
});
