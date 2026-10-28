/**
 * A sandboxed session's PR registration and sizing stay in its own project (epic
 * re-review, BUG 003bd959): PUT /prs/:repo/:number names no card, so the coverage
 * middleware let a session launched for project A resize - and read the anchor of -
 * project B's PR; POST /prs could upsert onto it the same way.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { AIRLOCK_SESSION_HEADER, airlockLaunchNonce, mintAirlockSessionMarker } from '@agenfk/core';

describe('PR routes across projects (BUG 003bd959)', () => {
  it('a session for project A cannot resize, re-register or read project B\'s PR; its own works', async () => {
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
      expect(theirsRes.status).toBe(404);
      expect(JSON.stringify(theirsRes.body)).not.toContain(theirCard);
      // re-registering B's PR under A's card does not take it over
      const over = await internal(request(server.app).post('/prs')).set(m).send({ itemId: myCard, prNumber: 7, repo: 'acme/app', sizing, model: 'm', harness: 'h' });
      expect(over.status).toBe(404);
      expect((await put(8)).status).toBeLessThan(300);
    } finally {
      await removeTestDb(dbFile, server.closeStorage);
    }
  }, 60_000);
});
