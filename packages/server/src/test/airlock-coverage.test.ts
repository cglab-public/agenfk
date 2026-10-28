/**
 * SX-1 (8dd7c7c0): which requests come from an Airlock sandbox, and which cards
 * they covered. The launcher's proxy stamps every sandbox request to this server
 * with a marker keyed by the report token (which the sandbox cannot read); the
 * middleware verifies it, never lets the header reach a route, and records every
 * card a covered request names. A card's tree is covered when ANY card in it is,
 * so moving a card elsewhere does not shed its coverage.
 *
 * Mounted on a bare express app over a real SQLite store, with stub routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { AIRLOCK_SESSION_HEADER, mintAirlockSessionMarker } from '@agenfk/core';
import { airlockCoverageMiddleware, airlockTreeCovered, coverWritesIn } from '../airlock/coverage';

const TOKEN = 'airlock-report-token-0123456789abcdef';
let storage: SQLiteStorageProvider;
let tmp: string;
let token: string | null;
let app: express.Express;
let seenHeader: unknown;

async function item(id: string, parentId?: string): Promise<void> {
  await storage.createItem({ id, projectId: 'p', type: parentId ? 'TASK' : 'STORY', title: id, status: 'TODO', parentId, createdAt: new Date(), updatedAt: new Date() } as any);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-coverage-'));
  storage = coverWritesIn(new SQLiteStorageProvider());
  await storage.init({ path: path.join(tmp, 'db.sqlite') });
  token = TOKEN;
  seenHeader = 'unset';
  app = express();
  app.use(express.json());
  app.use(airlockCoverageMiddleware({ storage: () => storage, reportToken: () => token }));
  const echo = (req: any, res: any) => { seenHeader = req.headers[AIRLOCK_SESSION_HEADER]; res.json({ covered: !!req.airlockSession }); };
  app.put('/items/:id', echo);
  // routes that write cards the way the real ones do: a bulk update, an import that creates several
  app.post('/items/bulk', async (req: any, res: any) => {
    for (const e of req.body.items) await storage.updateItem(e.id, e.updates);
    res.json({ ok: true });
  });
  app.post('/import', async (req: any, res: any) => {
    const made = [];
    for (const t of req.body.titles) made.push(await storage.createItem({ id: `imp-${t}`, projectId: 'p', type: 'TASK', title: t, status: 'TODO', createdAt: new Date(), updatedAt: new Date() } as any));
    res.json({ created: made.length });
  });
  app.post('/items/:id/validate', echo);
  app.post('/gatekeeper', echo);
  app.get('/items', echo);
  // writes the card as the real route does (storage.createItem)
  app.post('/items', async (req: any, res: any) => {
    try {
      const made = await storage.createItem({ id: req.body.id ?? 'created-1', projectId: 'p', type: 'TASK', title: req.body.title, status: 'TODO', parentId: req.body.parentId, createdAt: new Date(), updatedAt: new Date() } as any);
      res.status(201).json(made);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
  // the tree: story s1 > tasks t1, t2 > subtask t1a; another story s2
  await item('s1'); await item('t1', 's1'); await item('t2', 's1'); await item('t1a', 't1'); await item('s2');
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const marked = () => ({ [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(TOKEN, 'launch-1') });

describe('airlockCoverageMiddleware', () => {
  it('a marked request naming a card in its path covers that card', async () => {
    const res = await request(app).put('/items/t2').set(marked()).send({ title: 'x' });
    expect(res.body.covered).toBe(true);
    expect(await storage.airlockCoveredAmong(['t2'])).toEqual(['t2']);
  });

  it('the marker never reaches a route', async () => {
    await request(app).put('/items/t2').set(marked()).send({});
    expect(seenHeader).toBeUndefined();
  });

  // review: a marker that does not verify is refused (below), so it can never pass uncovered
  it('a forged or wrongly keyed marker is refused and covers nothing; no marker is an ordinary request', async () => {
    for (const headers of [
      { [AIRLOCK_SESSION_HEADER]: 'v1.x.' + 'a'.repeat(64) },
      { [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker('some-other-key-0123456789', 'launch-1') },
    ]) {
      expect((await request(app).put('/items/t2').set(headers).send({})).status).toBe(401);
    }
    const plain = await request(app).put('/items/t2').send({});
    expect(plain.body.covered).toBe(false);
    expect(await storage.airlockCoveredAmong(['t2'])).toEqual([]);
  });

  it('cards named in the body or the query are covered too', async () => {
    await request(app).post('/gatekeeper').set(marked()).send({ itemId: 't1', intent: 'edit' });
    await request(app).get('/items?itemId=s2').set(marked());
    expect((await storage.airlockCoveredAmong(['t1', 's2'])).sort()).toEqual(['s2', 't1']);
  });

  it('a card a covered request creates is covered, and so is the parent it names', async () => {
    const res = await request(app).post('/items').set(marked()).send({ id: 'new-1', parentId: 's2', title: 'n' });
    expect(res.status).toBe(201);
    expect((await storage.airlockCoveredAmong(['new-1', 's2'])).sort()).toEqual(['new-1', 's2']);
  });

  it('an uncovered request creating a card covers nothing', async () => {
    await request(app).post('/items').send({ id: 'new-2', title: 'n' });
    expect(await storage.airlockCoveredAmong(['new-2'])).toEqual([]);
  });
});

describe('airlockTreeCovered', () => {
  it('a card covered anywhere in a tree covers the whole tree, from any card of it', async () => {
    await storage.markAirlockCovered(['t1a'], '2026-10-28T10:00:00.000Z');
    for (const id of ['s1', 't1', 't2', 't1a']) expect(await airlockTreeCovered(storage, id), id).toBe(true);
    expect(await airlockTreeCovered(storage, 's2')).toBe(false);
  });

  it('moving a covered card into another tree covers that tree as well, and its old tree stays covered', async () => {
    await request(app).put('/items/t2').set(marked()).send({});
    await storage.updateItem('t2', { parentId: 's2' } as any);
    expect(await airlockTreeCovered(storage, 's2')).toBe(true);
    expect(await airlockTreeCovered(storage, 't1')).toBe(true);
  });

  it('an unknown card is not covered', async () => {
    expect(await airlockTreeCovered(storage, 'nope')).toBe(false);
  });
});

describe('SX-1 review (Codex gpt-6.1-sol 01a18235)', () => {
  it('route spellings Express accepts are covered too: case and a trailing slash', async () => {
    await request(app).post('/ITEMS/t2/validate').set(marked()).send({});
    expect(await storage.airlockCoveredAmong(['t2'])).toEqual(['t2']);
    await request(app).post('/items/').set(marked()).send({ id: 'new-3', title: 'n' });
    expect(await storage.airlockCoveredAmong(['new-3'])).toEqual(['new-3']);
  });

  it('a path segment that is not a card is not recorded as one', async () => {
    await request(app).post('/items/bulk').set(marked()).send({ items: [] });
    expect(await storage.airlockCoveredAmong(['bulk'])).toEqual([]);
  });

  it('every card a covered request writes is covered, whatever the route: a bulk move covers the card and both trees', async () => {
    await request(app).post('/items/bulk').set(marked()).send({ items: [{ id: 't1', updates: { parentId: 's2' } }] });
    expect(await airlockTreeCovered(storage, 's2')).toBe(true);
    expect(await airlockTreeCovered(storage, 't2')).toBe(true);
    expect((await storage.airlockCoveredAmong(['t1'])).length).toBe(1);
  });

  it('cards a covered request creates through any route are covered', async () => {
    await request(app).post('/import').set(marked()).send({ titles: ['a', 'b'] });
    expect((await storage.airlockCoveredAmong(['imp-a', 'imp-b'])).sort()).toEqual(['imp-a', 'imp-b']);
  });

  it('writes outside a covered request cover nothing', async () => {
    await request(app).post('/import').send({ titles: ['c'] });
    await storage.updateItem('t2', { title: 'renamed' } as any);
    expect(await storage.airlockCoveredAmong(['imp-c', 't2'])).toEqual([]);
  });

  it('a marker that does not verify is refused, not let through uncovered', async () => {
    const res = await request(app).put('/items/t2').set(AIRLOCK_SESSION_HEADER, mintAirlockSessionMarker('some-other-key-0123456789', 'x')).send({});
    expect(res.status).toBe(401);
    expect(res.headers['x-agenfk-airlock-marker']).toBe('invalid');
    expect(seenHeader).toBe('unset');
  });

  it('a marker the server cannot check (no token, or the read fails) is refused', async () => {
    token = null;
    expect((await request(app).put('/items/t2').set(marked()).send({})).status).toBe(503);
    expect(seenHeader).toBe('unset');
  });
});

describe('SX-1 review pass 2', () => {
  it('a card is recorded as covered before it is written: when recording fails, no uncovered card is left', async () => {
    // the middleware's own record (the parent it names) succeeds; the one made for the new card fails
    const real = storage.markAirlockCovered.bind(storage);
    const spy = vi.spyOn(storage, 'markAirlockCovered')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('disk full'));
    const res = await request(app).post('/items').set(marked()).send({ id: 'new-9', parentId: 's2', title: 'n' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    expect(await storage.getItem('new-9')).toBeNull();
  });

  it('a card created under a parent covers the parent\'s tree before the write', async () => {
    await request(app).post('/import').set(marked()).send({ titles: ['z'] });
    await request(app).post('/items').set(marked()).send({ id: 'new-10', parentId: 't1', title: 'n' });
    expect(await airlockTreeCovered(storage, 's1')).toBe(true);
    expect(await storage.airlockCoveredAmong(['new-10'])).toEqual(['new-10']);
  });
});
