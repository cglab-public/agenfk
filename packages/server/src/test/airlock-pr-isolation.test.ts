/**
 * A sandboxed session's PR routes are not kept to its own project (da69b17a, user
 * decision 2026-10-30): Airlock blocks harmful agent behaviour, not one AgEnFK
 * project's agent working on another's cards. BUG 003bd959's per-project 404s are gone.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { AIRLOCK_SESSION_HEADER, airlockLaunchNonce, mintAirlockSessionMarker } from '@agenfk/core';

describe('PR routes across projects (da69b17a)', () => {
  it('a session for project A resizes and re-registers project B\'s PR as it does its own', async () => {
    const { removeTestDb, testDbPath } = await import('./helpers/testDb');
    const { ensureAirlockReportToken } = await import('../airlock/reportToken');
    const server = await import('../server');
    const dbFile = testDbPath('airlock-pr-isolation.sqlite');
    process.env.AGENFK_DB_PATH = dbFile;
    await removeTestDb(dbFile, server.closeStorage);
    await server.initStorage();
    try {
      const token = ensureAirlockReportToken();
      const internal = (r: request.Test) => r.set('x-agenfk-internal', server.VERIFY_TOKEN!);
      const mine = (await internal(request(server.app).post('/projects')).send({ name: 'pr-mine' })).body.id;
      const theirs = (await internal(request(server.app).post('/projects')).send({ name: 'pr-theirs' })).body.id;
      const card = async (projectId: string) => (await internal(request(server.app).post('/items')).send({ projectId, type: 'TASK', title: 't' })).body.id;
      const theirCard = await card(theirs);
      const myCard = await card(mine);
      const sizing = { epic: 0, story: 0, task: 1, bug: 0 };
      const reg = (itemId: string, prNumber: number) => internal(request(server.app).post('/prs')).send({ itemId, prNumber, repo: 'acme/app', sizing, model: 'm', harness: 'h' });
      expect((await reg(theirCard, 7)).status).toBeLessThan(300);
      expect((await reg(myCard, 8)).status).toBeLessThan(300);
      const m = { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(token, airlockLaunchNonce(mine, 'launch-pr')) };
      const put = (n: number) => internal(request(server.app).put(`/prs/${encodeURIComponent('acme/app')}/${n}`)).set(m).send({ sizing: { epic: 9, story: 9, task: 9, bug: 9 }, model: 'm', harness: 'h' });
      const theirsRes = await put(7);
      expect(theirsRes.status, JSON.stringify(theirsRes.body)).toBeLessThan(300);
      // re-registering B's PR from the sandbox goes through as it would outside it
      const over = await internal(request(server.app).post('/prs')).set(m).send({ itemId: theirCard, prNumber: 7, repo: 'acme/app', sizing, model: 'm', harness: 'h' });
      expect(over.status, JSON.stringify(over.body)).toBeLessThan(300);
      expect((await put(8)).status).toBeLessThan(300);
    } finally {
      await removeTestDb(dbFile, server.closeStorage);
    }
  }, 60_000);
});
