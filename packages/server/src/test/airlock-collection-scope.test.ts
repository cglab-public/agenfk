/**
 * A sandboxed session's listings are its own project's (BUG afc07064, epic review).
 *
 * The coverage middleware refuses a request that NAMES another project or card;
 * a listing that names none - GET /items, GET /projects - used to answer with
 * every project's records. For a marked request:
 *  - /items, /agent-runs, /token-events are read with the launch's project as
 *    their filter, whatever the request said;
 *  - /projects answers with the launch's project only;
 *  - listings that cannot be narrowed to one project (Airlock approvals,
 *    decisions, learning; verify runs; hub refusals; the database status) are
 *    refused.
 * An unmarked request (the board, the CLI outside the sandbox) is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { AIRLOCK_SESSION_HEADER, airlockLaunchNonce, mintAirlockSessionMarker } from '@agenfk/core';
import { airlockCoverageMiddleware, coverWritesIn } from '../airlock/coverage';
import { airlockCollectionScope, AIRLOCK_UNSCOPED_LISTING } from '../airlock/scope';

const TOKEN = 'airlock-report-token-0123456789abcdef';
let storage: SQLiteStorageProvider;
let tmp: string;
let app: express.Express;

const PROJECTS = [{ id: 'p', name: 'mine' }, { id: 'q', name: 'theirs' }];
const ITEMS = [{ id: 'i1', projectId: 'p' }, { id: 'i2', projectId: 'q' }];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-scope-'));
  storage = coverWritesIn(new SQLiteStorageProvider());
  await storage.init({ path: path.join(tmp, 'db.sqlite') });
  app = express();
  app.use(express.json());
  app.use(airlockCoverageMiddleware({ storage: () => storage, reportToken: () => TOKEN }));
  app.use(airlockCollectionScope());
  // listings as the real routes answer them: filtered by ?projectId when given
  const byProject = (req: any) => (req.query.projectId ? ITEMS.filter(i => i.projectId === req.query.projectId) : ITEMS);
  app.get('/items', (req: any, res: any) => res.json(byProject(req)));
  app.get('/agent-runs', (req: any, res: any) => res.json(byProject(req)));
  app.get('/token-events', (req: any, res: any) => res.json({ events: byProject(req) }));
  app.get('/projects', (_req: any, res: any) => res.json(PROJECTS));
  for (const p of ['/airlock/approvals', '/airlock/decisions', '/airlock/learning', '/verify-runs', '/hub/refusals', '/db/status']) {
    app.get(p, (_req: any, res: any) => res.json({ everything: true }));
  }
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const marked = (project = 'p') => ({ [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(TOKEN, airlockLaunchNonce(project, 'launch1')) });

describe('a sandboxed session\'s listings (BUG afc07064)', () => {
  it('an unfiltered card, run or token listing is read with the launch\'s project as its filter', async () => {
    for (const p of ['/items', '/agent-runs', '/ITEMS/', '/items?status=TODO']) {
      const res = await request(app).get(p).set(marked());
      expect(res.status, p).toBe(200);
      expect(res.body.map((i: any) => i.projectId), p).toEqual(['p']);
    }
    const tokens = await request(app).get('/token-events').set(marked());
    expect(tokens.body.events.map((i: any) => i.projectId)).toEqual(['p']);
  });

  it('the projects listing answers with the launch\'s project only', async () => {
    const res = await request(app).get('/projects').set(marked());
    expect(res.body).toEqual([{ id: 'p', name: 'mine' }]);
    expect((await request(app).get('/projects/').set(marked('q'))).body).toEqual([{ id: 'q', name: 'theirs' }]);
  });

  it('listings that cannot be narrowed to one project are refused', async () => {
    for (const p of ['/airlock/approvals', '/airlock/decisions', '/airlock/learning', '/verify-runs', '/hub/refusals', '/db/status', '/Airlock/Approvals/']) {
      const res = await request(app).get(p).set(marked());
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe(AIRLOCK_UNSCOPED_LISTING);
    }
  });

  it('review: a launch signed for no project gets no listing at all', async () => {
    const none = { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(TOKEN, airlockLaunchNonce(null, 'launch-none')) };
    for (const p of ['/items', '/agent-runs', '/token-events', '/projects', '/airlock/approvals']) {
      const res = await request(app).get(p).set(none);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe(AIRLOCK_UNSCOPED_LISTING);
    }
  });

  it('review: HEAD is judged as GET', async () => {
    expect((await request(app).head('/airlock/approvals').set(marked())).status).toBe(403);
    const res = await request(app).head('/items').set(marked());
    expect(res.status).toBe(200);
    // the body HEAD would have carried is the filtered one: its length is that of the launch's project alone
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(JSON.stringify([{ id: 'i1', projectId: 'p' }])));
  });

  it('an unmarked request is untouched', async () => {
    expect((await request(app).get('/items')).body).toHaveLength(2);
    expect((await request(app).get('/projects')).body).toHaveLength(2);
    expect((await request(app).get('/airlock/approvals')).status).toBe(200);
  });
});

describe('the real server: a marked unfiltered listing (BUG afc07064)', () => {
  it('GET /items and GET /projects answer with the launch\'s project only', async () => {
    const { removeTestDb, testDbPath } = await import('./helpers/testDb');
    const { ensureAirlockReportToken } = await import('../airlock/reportToken');
    const server = await import('../server');
    const dbFile = testDbPath('airlock-collection-scope-real.sqlite');
    process.env.AGENFK_DB_PATH = dbFile;
    await removeTestDb(dbFile, server.closeStorage);
    await server.initStorage();
    try {
      const token = ensureAirlockReportToken();
      const internal = (r: request.Test) => r.set('x-agenfk-internal', server.VERIFY_TOKEN!);
      const mine = (await internal(request(server.app).post('/projects')).send({ name: 'scope-mine' })).body.id;
      const theirs = (await internal(request(server.app).post('/projects')).send({ name: 'scope-theirs' })).body.id;
      for (const projectId of [mine, theirs]) {
        expect((await internal(request(server.app).post('/items')).send({ projectId, type: 'TASK', title: `in ${projectId}` })).status).toBeLessThan(300);
      }
      const m = { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(token, airlockLaunchNonce(mine, 'launch-real')) };
      const items = await request(server.app).get('/items').set(m);
      expect(items.status, JSON.stringify(items.body)).toBe(200);
      const list = Array.isArray(items.body) ? items.body : items.body.items;
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((i: any) => i.projectId))).toEqual(new Set([mine]));
      const projects = await request(server.app).get('/projects').set(m);
      expect(projects.body.map((p: any) => p.id)).toEqual([mine]);
      // the board still sees both
      expect((await request(server.app).get('/projects')).body.map((p: any) => p.id)).toEqual(expect.arrayContaining([mine, theirs]));
      // review: a verify run is read through its card's project - another project's is not there
      const theirsItem = (await internal(request(server.app).post('/items')).send({ projectId: theirs, type: 'TASK', title: 'run here' })).body;
      const v = await internal(request(server.app).post(`/items/${theirsItem.id}/validate`)).send({ evidence: 'start', async: true });
      const runId = v.body?.runId;
      if (runId) {
        expect((await internal(request(server.app).get(`/items/validate-runs/${runId}`))).status).toBe(200);
        expect((await internal(request(server.app).get(`/items/validate-runs/${runId}`)).set(m)).status).toBe(404);
      }
      expect(runId, JSON.stringify(v.body)).toBeTruthy();
    } finally {
      await removeTestDb(dbFile, server.closeStorage);
    }
  }, 60_000);
});
