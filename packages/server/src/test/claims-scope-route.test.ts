/**
 * @vitest-environment node
 *
 * Claims follow the card when its TREE changes (N4/N5).
 *
 * The scope is what a claim is checked against, so changing the scope without
 * re-checking is how the same collision reappears one step later:
 *
 *  - removing a worktree drops the card back into the project tree, where its
 *    claims may collide with a card already working there (N4);
 *  - moving a CHILD to another project left `parentId` pointing across
 *    projects, so the tree resolver and the claim-scope resolver disagreed
 *    about where the card works (N5).
 *
 * Both are refused rather than allowed and reconciled later.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const TEST_DB = path.resolve('./claims-scope-route-test-db.sqlite');

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

const project = async (name: string): Promise<string> =>
  (await agent().post('/projects').send({ name })).body.id;

const card = async (projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> =>
  (await agent().post('/items').send({ projectId, type: 'TASK', title, status: 'TODO', ...extra })).body.id;

describe('removing a worktree re-checks the claims (N4)', () => {
  it('refuses when the card would then collide in the project tree', async () => {
    const projectId = await project('claims-n4');
    const mine = await card(projectId, 'has a worktree');
    const other = await card(projectId, 'works in the main tree');
    // Set the worktree directly: the API never lets a caller choose a path.
    await storage.updateItem(mine, { worktreePath: '/wt/mine' } as never);
    // Declared through the PUT, which is the route that validates claims.
    await agent().put(`/items/${mine}`).send({ claims: ['src/x.ts'] });
    await agent().put(`/items/${other}`).send({ claims: ['src/x.ts'] });

    const res = await agent()
      .delete(`/items/${mine}/worktree`)
      .set('x-agenfk-internal', VERIFY_TOKEN);

    expect(res.status).toBe(409);
    expect(res.body.error, 'the refusal must name the collision').toMatch(/collide/);
    // Nothing was removed.
    expect((await storage.getItem(mine))?.worktreePath).toBe('/wt/mine');
    expect((await storage.getItem(other))?.claims).toEqual(['src/x.ts']);
  });

  it('removes it when nothing collides in the project tree', async () => {
    const projectId = await project('claims-n4-clear');
    const mine = await card(projectId, 'alone');
    await storage.updateItem(mine, { worktreePath: '/wt/alone' } as never);
    await agent().put(`/items/${mine}`).send({ claims: ['src/x.ts'] });
    const res = await agent()
      .delete(`/items/${mine}/worktree`)
      .set('x-agenfk-internal', VERIFY_TOKEN);
    expect(res.status).toBe(200);
    expect((await storage.getItem(mine))?.worktreePath).toBeUndefined();
  });
});

describe('a child cannot move to another project on its own (N5)', () => {
  it('refuses, because it shares its parent project, branch and worktree', async () => {
    const from = await project('claims-n5-from');
    const to = await project('claims-n5-to');
    const parent = await card(from, 'parent');
    const child = await card(from, 'child', { parentId: parent });

    const res = await agent().post(`/items/${child}/move`).send({ targetProjectId: to });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/child item cannot be moved on its own/i);
    expect((await storage.getItem(child))?.projectId).toBe(from);
  });

  it('still moves a top-level card', async () => {
    const from = await project('claims-n5-top-from');
    const to = await project('claims-n5-top-to');
    const top = await card(from, 'top');
    const res = await agent().post(`/items/${top}/move`).send({ targetProjectId: to });
    expect(res.status).toBe(200);
    expect((await storage.getItem(top))?.projectId).toBe(to);
  });
});