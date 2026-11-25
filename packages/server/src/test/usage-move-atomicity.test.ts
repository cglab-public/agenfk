/**
 * GH-389, third review round: a move computes its usage first (seconds, while
 * session logs are flushed) and is saved after, so the save must be a real
 * compare-and-write. These pin that it is:
 *  - two overlapping saves of the same move: only one lands;
 *  - a card that left and came back to the same status meanwhile: refused;
 *  - a close whose sub-card (at any depth) was reopened meanwhile: refused,
 *    by verify and by the parent roll-up alike;
 *  - a close that could not compute its total replaces the old total with
 *    nothing, rather than letting the previous close's total come back.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('usage-move-atomicity-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN, saveMove, usagePatch } from '../server';
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
async function project() {
  const st = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${seq}`, name, label: name, order, ...extra });
  const f = await agent().post('/flows').send({ name: `atomic-${++seq}`, steps: [st('TODO', 0, { isAnchor: true }), st('WORK', 1), st('DONE', 2, { isAnchor: true })] });
  const dir = echoRepo(A, 'agenfk-usage-atomic-');
  dirs.push(dir);
  const p = await agent().post('/projects').send({ name: `atomic-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return p.body.id as string;
}
const make = async (projectId: string, type: string, parentId?: string, status = 'WORK') => {
  const c = await agent().post('/items').send({ type, title: `${type}-${++seq}`, projectId, ...(parentId ? { parentId } : {}) });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
};
// .then() sends it: a supertest request is lazy.
const verify = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' }).then((r) => r);
const reopen = (id: string) => agent().put(`/items/${id}`).set({ 'x-agenfk-ui': '1' }).send({ status: 'WORK' }).then((r) => r);
const NO = { step: null, card: null };

/** Hold the FIRST usage computation of `itemId` until released. */
function holdUsageOf(itemId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const inside = new Promise<void>((r) => { reached = r; });
  let held = false;
  const real = storage.sessionsForItem.bind(storage);
  const spy = vi.spyOn(storage, 'sessionsForItem').mockImplementation(async (id: string) => {
    if (id === itemId && !held) { held = true; reached(); await gate; }
    return real(id);
  });
  return { inside, release: () => release(), restore: () => { release(); spy.mockRestore(); } };
}

describe('the save of a move is a compare-and-write', () => {
  it('two overlapping saves of the same move: only one lands', async () => {
    const id = await make(await project(), 'TASK');
    const item: any = await storage.getItem(id);
    const [a, b] = await Promise.all([
      saveMove(id, item, { status: 'DONE' }, NO),
      saveMove(id, item, { status: 'TODO' }, NO),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const after: any = await storage.getItem(id);
    expect(after.history.length).toBe(item.history.length + 1);
  });

  it('a card that left the status and came back meanwhile is refused', async () => {
    const id = await make(await project(), 'TASK');
    const item: any = await storage.getItem(id);
    await storage.updateItem(id, { status: 'TODO' } as any);
    await storage.updateItem(id, { status: 'WORK' } as any);
    expect(await saveMove(id, item, { status: 'DONE' }, NO)).toBeNull();
  });

  it('a verify closing a card whose sub-card was reopened meanwhile is refused', async () => {
    const projectId = await project();
    const story = await make(projectId, 'STORY');
    const task = await make(projectId, 'TASK', story, 'DONE');
    const hold = holdUsageOf(story);
    try {
      const pending = verify(story);
      await hold.inside;
      expect((await reopen(task)).status).toBe(200);
      hold.release();
      expect((await pending).status).toBe(409);
    } finally {
      hold.restore();
    }
    expect((await agent().get(`/items/${story}`)).body.status).toBe('WORK');
  });

  it('a roll-up closing a grandparent whose grandchild was reopened meanwhile is refused', async () => {
    const projectId = await project();
    const p = await make(projectId, 'EPIC');
    const s = await make(projectId, 'STORY', p);
    const t = await make(projectId, 'TASK', s);
    const hold = holdUsageOf(p);
    try {
      const closingT = verify(t); // T DONE -> S rolls up to DONE -> P starts rolling up
      await hold.inside;
      expect((await reopen(t)).status).toBe(200); // S stays DONE: roll-ups never move a parent back
      hold.release();
      expect((await closingT).status).toBe(200);
    } finally {
      hold.restore();
    }
    expect((await agent().get(`/items/${p}`)).body.status).not.toBe('DONE');
  });

  it('a child created while a close is being saved lands after it, never between its check and its write', async () => {
    const projectId = await project();
    const story = await make(projectId, 'STORY');
    const item: any = await storage.getItem(story);
    const order: string[] = [];
    let creating: Promise<unknown> | null = null;
    const real = storage.listItems.bind(storage);
    const spy = vi.spyOn(storage, 'listItems').mockImplementation(async (q: any) => {
      const rows = await real(q);
      // The close's subtree scan has just read the children: a new one arrives now.
      if (q?.parentId === story && !creating) {
        creating = storage.createItem({ id: `late-${++seq}`, projectId, parentId: story, type: 'TASK', title: 'late', description: '', status: 'WORK', createdAt: new Date(), updatedAt: new Date(), history: [], comments: [], tests: [], context: [] } as any)
          .then(() => order.push('created'));
      }
      return rows;
    });
    try {
      const saved = await saveMove(story, item, { status: 'DONE' }, { step: null, card: null, closing: true });
      order.push(saved ? 'closed' : 'refused');
      await creating;
    } finally {
      spy.mockRestore();
    }
    expect(order).toEqual(['closed', 'created']);
  });

  it('a close whose total could not be computed clears the old total instead of reviving it', () => {
    const fresh = { usageByStep: [], cardUsage: { total: { turns: 9 }, atStatus: 'DONE' } };
    expect(usagePatch(fresh, { step: null, card: null, closing: true })).toEqual({ cardUsage: null });
    expect(usagePatch(fresh, { step: null, card: null })).toEqual({});
  });
});
