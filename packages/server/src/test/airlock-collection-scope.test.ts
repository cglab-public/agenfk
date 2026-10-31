/**
 * A sandboxed session's listings are every project's, as they are outside the
 * sandbox (da69b17a, user decision 2026-10-30). Airlock blocks harmful agent
 * behaviour - egress, host terminals, project commands - and does not keep
 * AgEnFK projects apart: BUG afc07064's per-project filter and its refusals of
 * listings that span projects are gone, for a launch signed for a project and
 * for one signed for none.
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

const NONE = () => ({ [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(TOKEN, airlockLaunchNonce(null, 'launch-none')) });

describe('a sandboxed session\'s listings (da69b17a)', () => {
  it('a card, run or token listing answers with every project\'s records, for a launch with a project or none', async () => {
    for (const h of [marked(), marked('q'), NONE()]) {
      for (const p of ['/items', '/agent-runs', '/ITEMS/', '/items?status=TODO']) {
        const res = await request(app).get(p).set(h);
        expect(res.status, p).toBe(200);
        expect(res.body.map((i: any) => i.projectId), p).toEqual(['p', 'q']);
      }
      expect((await request(app).get('/token-events').set(h)).body.events.map((i: any) => i.projectId)).toEqual(['p', 'q']);
    }
  });

  it('a listing that names a project answers with that project\'s records, whichever the launch was for', async () => {
    const res = await request(app).get('/items?projectId=q').set(marked('p'));
    expect(res.status).toBe(200);
    expect(res.body.map((i: any) => i.projectId)).toEqual(['q']);
  });

  it('the projects listing answers with every project', async () => {
    expect((await request(app).get('/projects').set(marked())).body).toEqual(PROJECTS);
    expect((await request(app).get('/projects/').set(NONE())).body).toEqual(PROJECTS);
  });

  it('listings that span projects are answered (verify runs, hub refusals, database status)', async () => {
    for (const h of [marked(), NONE()]) {
      for (const p of ['/verify-runs', '/hub/refusals', '/db/status', '/DB/Status/']) {
        const res = await request(app).get(p).set(h);
        expect(res.status, p).toBe(200);
        expect(res.body).toEqual({ everything: true });
      }
    }
  });

  it('HEAD is answered as GET', async () => {
    expect((await request(app).head('/verify-runs').set(marked())).status).toBe(200);
    const res = await request(app).head('/items').set(marked());
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(JSON.stringify(ITEMS)));
  });
});

describe('the real server: a marked listing (da69b17a)', () => {
  it('GET /items and GET /projects answer with every project, and another project\'s verify run is readable', async () => {
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
      for (const nonce of [airlockLaunchNonce(mine, 'launch-real'), airlockLaunchNonce(null, 'launch-real-none')]) {
        const m = { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(token, nonce) };
        const items = await request(server.app).get('/items').set(m);
        expect(items.status, JSON.stringify(items.body)).toBe(200);
        const list = Array.isArray(items.body) ? items.body : items.body.items;
        expect(new Set(list.map((i: any) => i.projectId))).toEqual(new Set([mine, theirs]));
        const projects = await request(server.app).get('/projects').set(m);
        expect(projects.status).toBe(200);
        expect(projects.body.map((p: any) => p.id)).toEqual(expect.arrayContaining([mine, theirs]));
        // listings that span projects are answered, not refused (Airlock's own records stay the
        // board's: airlock-coverage.test.ts)
        for (const p of ['/verify-runs', '/db/status']) {
          const res = await request(server.app).get(p).set(m);
          expect(res.status, `${p} ${JSON.stringify(res.body)}`).not.toBe(403);
          expect(JSON.stringify(res.body)).not.toContain('AIRLOCK_UNSCOPED_LISTING');
        }
      }
      const m = { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(token, airlockLaunchNonce(mine, 'launch-real')) };
      const theirsItem = (await internal(request(server.app).post('/items')).send({ projectId: theirs, type: 'TASK', title: 'run here' })).body;
      const v = await internal(request(server.app).post(`/items/${theirsItem.id}/validate`)).send({ evidence: 'start', async: true });
      const runId = v.body?.runId;
      expect(runId, JSON.stringify(v.body)).toBeTruthy();
      const run = await internal(request(server.app).get(`/items/validate-runs/${runId}`)).set(m);
      expect(run.status).toBe(200);
      expect(run.body.itemId).toBe(theirsItem.id);
    } finally {
      await removeTestDb(dbFile, server.closeStorage);
    }
  }, 60_000);
});

describe('the real server: Socket.IO from a sandbox (da69b17a review)', () => {
  it('a marked polling request is refused before Engine.IO answers it; an unmarked one is served', async () => {
    const { removeTestDb, testDbPath } = await import('./helpers/testDb');
    const { ensureAirlockReportToken } = await import('../airlock/reportToken');
    const server = await import('../server');
    const dbFile = testDbPath('airlock-socketio-sandbox.sqlite');
    process.env.AGENFK_DB_PATH = dbFile;
    await removeTestDb(dbFile, server.closeStorage);
    await server.initStorage();
    try {
      const token = ensureAirlockReportToken();
      const m = { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(token, airlockLaunchNonce('p', 'launch-io')) };
      const poll = '/socket.io/?EIO=4&transport=polling';
      const plain = await request(server.httpServer).get(poll);
      expect(plain.status, plain.text).toBe(200);
      const marked = await request(server.httpServer).get(poll).set(m);
      expect(marked.status, marked.text).toBe(403);
      expect(marked.text).not.toContain('"sid"');
    } finally {
      await removeTestDb(dbFile, server.closeStorage);
    }
  }, 60_000);
});
