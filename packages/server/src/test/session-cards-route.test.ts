/**
 * GH-389: the server records which card a harness session works on, for token
 * attribution. Two writers: the gatekeeper (POST /session-cards, sent by the
 * CLI after an authorized check) and verify (the caller's actor). A card that
 * lands on its flow's end records an "ended" row for that session, so the
 * session's later turns are not charged to a closed card.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('session-cards-route-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { echoRepo, A } from './helpers/echoRepo';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let seq = 0;
async function card(status = 'TODO', extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `sc-${++seq}` });
  await storage.updateProject(p.body.id, extra as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `sc-${++seq}`, projectId: p.body.id });
  if (status !== 'TODO') await storage.updateItem(c.body.id, { status } as any);
  return { id: c.body.id as string, projectId: p.body.id as string };
}
const now = () => new Date(Date.now() + 1000).toISOString();

describe('POST /session-cards', () => {
  it('records the card for the session', async () => {
    const c = await card();
    const res = await agent().post('/session-cards').set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ client: 'claude-code', sessionId: 'sess-gk-1', itemId: c.id });
    expect(res.status).toBe(204);
    expect(await storage.sessionCardAt('claude-code', 'sess-gk-1', now())).toEqual({ itemId: c.id, projectId: c.projectId });
  });

  it('refuses a client that is not a harness ingestion knows', async () => {
    const c = await card();
    const res = await agent().post('/session-cards').set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ client: 'notepad', sessionId: 's', itemId: c.id });
    expect(res.status).toBe(400);
  });

  it('refuses a session id that is not a plain identifier', async () => {
    const c = await card();
    for (const sessionId of ['', '../../etc', 'x'.repeat(200), 42]) {
      const res = await agent().post('/session-cards').set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ client: 'pi', sessionId, itemId: c.id });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a caller without the internal token, and a form post from a web page', async () => {
    const c = await card();
    const bare = await agent().post('/session-cards').send({ client: 'pi', sessionId: 'sess-forged', itemId: c.id });
    const form = await agent().post('/session-cards').type('form').send(`client=pi&sessionId=sess-forged&itemId=${c.id}`);
    expect([bare.status, form.status]).toEqual([403, 403]);
    expect(await storage.sessionsForItem(c.id)).toEqual([]);
  });

  it('refuses a card that does not exist', async () => {
    const res = await agent().post('/session-cards').set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ client: 'pi', sessionId: 'sess-x', itemId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('verify records the caller session', () => {
  const validate = (id: string, actor?: unknown) => agent().post(`/items/${id}/validate`)
    .set({ 'x-agenfk-internal': VERIFY_TOKEN! })
    .send({ evidence: 'ok', ...(actor ? { actor } : {}) });

  it('a verify with an actor puts that session on the card', async () => {
    const c = await card();
    await validate(c.id, { client: 'pi', sessionId: 'sess-verify-1' });
    expect(await storage.sessionCardAt('pi', 'sess-verify-1', now())).toEqual({ itemId: c.id, projectId: c.projectId });
  });

  it('a verify without an actor records nothing', async () => {
    const c = await card();
    await validate(c.id);
    expect(await storage.sessionsForItem(c.id)).toEqual([]);
  });

  it('landing on the end of the flow ends the session on that card', async () => {
    const dir = echoRepo(A, 'agenfk-session-cards-');
    dirs.push(dir);
    const c = await card('TEST', { projectRoot: dir, verifyCommand: 'exit 0' });
    const res = await validate(c.id, { client: 'claude-code', sessionId: 'sess-close-1' });
    expect(res.status).toBe(200);
    expect((await agent().get(`/items/${c.id}`)).body.status).toBe('DONE');
    expect(await storage.sessionCardAt('claude-code', 'sess-close-1', now())).toEqual({ itemId: null, projectId: c.projectId });
  });
});
