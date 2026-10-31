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
import { AIRLOCK_SESSION_HEADER, airlockLaunchNonce, mintAirlockSessionMarker } from '@agenfk/core';
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
  const echo = (req: any, res: any) => { seenHeader = req.headers[AIRLOCK_SESSION_HEADER]; res.json({ covered: !!req.airlockSession, project: req.airlockProject ?? null }); };
  app.put('/items/:id', echo);
  // routes that write cards the way the real ones do: a bulk update, an import that creates several
  app.post('/items/bulk', async (req: any, res: any) => {
    try {
      for (const e of req.body.items) await storage.updateItem(e.id, e.updates);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
  app.post('/import', async (req: any, res: any) => {
    try {
      const made = [];
      for (const t of req.body.titles) made.push(await storage.createItem({ id: `imp-${t}`, projectId: 'p', type: 'TASK', title: t, status: 'TODO', createdAt: new Date(), updatedAt: new Date() } as any));
      res.json({ created: made.length });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
  app.post('/items/:id/validate', echo);
  for (const route of ['/projects/:id/verify-command', '/projects/:id/setup-command', '/projects/:id/test-report']) app.put(route, echo);
  app.post('/internal/hub/reload', echo);
  app.post('/flows', echo); app.put('/flows/:id', echo); app.delete('/flows/:id', echo); app.get('/flows/:id', echo);
  app.post('/projects/:id/flow', echo); app.post('/projects/:id/flow/select-org', echo); app.post('/registry/flows/install', echo);
  for (const [m, route] of [['get', '/herdr/sessions'], ['post', '/herdr/panes/:paneId/text'], ['post', '/herdr/panes/:paneId/keys'], ['get', '/herdr/panes/:paneId/content'], ['post', '/terminal-sessions'], ['get', '/terminal-sessions'], ['delete', '/terminal-sessions/:id']] as const) (app as any)[m](route, echo);
  app.post('/gatekeeper', echo);
  app.put('/projects/:id', echo);
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

const marked = (project: string | null = 'p') => ({ [AIRLOCK_SESSION_HEADER]: mintAirlockSessionMarker(TOKEN, airlockLaunchNonce(project, 'launch1')) });

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

describe('PO-1 review: the marker names the launch\'s project', () => {
  it('a marked request carries the project its launch was signed for; an unmarked one, none', async () => {
    expect((await request(app).get('/items').set(marked('p'))).body).toEqual({ covered: true, project: 'p' });
    expect((await request(app).get('/items').set(marked(null))).body).toEqual({ covered: true, project: null });
    expect((await request(app).get('/items')).body).toEqual({ covered: false, project: null });
  });

  it('a launcher from before PO-1 (its nonce says no project either way) is refused, telling it to restart', async () => {
    const res = await request(app).put('/items/t1').set(AIRLOCK_SESSION_HEADER, mintAirlockSessionMarker(TOKEN, 'launch-1')).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AIRLOCK_LAUNCH_OUTDATED');
    expect(await airlockTreeCovered(storage, 't1')).toBe(false);
  });

  it('a launch reaches a card or project of any project, and one launched outside every project does too (da69b17a)', async () => {
    for (const project of ['q', null]) {
      const res = await request(app).post('/items/t1/validate').set(marked(project)).send({});
      expect(res.status, String(project)).toBe(200);
    }
    expect((await request(app).post('/gatekeeper').set(marked('q')).send({ itemId: 's2' })).status).toBe(200);
    expect((await request(app).post('/gatekeeper').set(marked('q')).send({ projectId: 'p' })).status).toBe(200);
    expect((await request(app).put('/projects/p').set(marked('q')).send({})).status).toBe(200);
    // still recorded: the card's own commands run in the sandbox, whoever's launch touched it
    expect(await airlockTreeCovered(storage, 't1')).toBe(true);
    expect(await airlockTreeCovered(storage, 's2')).toBe(true);
  });

  it('and writes one: a card created or moved into another project is written, and covered (da69b17a)', async () => {
    expect((await request(app).post('/import').set(marked('q')).send({ titles: ['x'] })).status).toBe(200);
    expect(await storage.getItem('imp-x')).toBeTruthy();
    expect(await airlockTreeCovered(storage, 'imp-x')).toBe(true);
    expect((await request(app).post('/items/bulk').set(marked('p')).send({ items: [{ id: 't2', updates: { projectId: 'q' } }] })).status).toBe(200);
    expect((await storage.getItem('t2') as any).projectId).toBe('q');
    expect(await airlockTreeCovered(storage, 't2')).toBe(true);
  });
});

describe('PO-1 review 3 (Codex gpt-6.1-sol 01a182d1)', () => {
  it('a sandbox cannot repoint a project\'s root (its repository picks its overrides): not by the route, not by any write', async () => {
    app.put('/projects/:id/project-root', echo2);
    app.post('/repoint', async (req: any, res: any) => {
      try { await storage.updateProject('p', { projectRoot: '/elsewhere' } as any); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
    });
    await storage.createProject({ id: 'p', name: 'p', projectRoot: '/orig', createdAt: new Date(), updatedAt: new Date() } as any);
    const res = await request(app).put('/projects/p/project-root').set(marked('p')).send({ projectRoot: '/elsewhere' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AIRLOCK_PROJECT_ROOT');
    expect((await request(app).post('/repoint').set(marked('p')).send({})).status).toBe(500);
    expect(((await storage.getProject('p')) as any).projectRoot).toBe('/orig');
    // outside a sandbox nothing changes
    expect((await request(app).post('/repoint').send({})).status).toBe(200);
  });

  it('a sandbox cannot delete a project (its repository pin would go with it)', async () => {
    app.delete('/projects/:id', echo2);
    const res = await request(app).delete('/projects/p').set(marked('p'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AIRLOCK_PROJECT_ROOT');
    expect((await request(app).delete('/projects/p')).status).toBe(200);
  });

  it('a run is reached whatever project its card is in, and covers that card (da69b17a)', async () => {
    app.patch('/agent-runs/:id', echo2);
    app.post('/agent-runs/:id/events', echo2);
    await (storage as any).createAgentRun({ id: 'run-b', itemId: 's2', projectId: 'p', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'm', status: 'running', startedAt: new Date().toISOString() });
    expect((await request(app).patch('/agent-runs/run-b').set(marked('q')).send({ status: 'done' })).status).toBe(200);
    expect((await request(app).post('/agent-runs/run-b/events').set(marked(null)).send({})).status).toBe(200);
    expect(await airlockTreeCovered(storage, 's2')).toBe(true);
  });

  it('a run whose card is gone is reached too: it covers nothing (da69b17a)', async () => {
    app.patch('/agent-runs/:id', echo2);
    await (storage as any).createAgentRun({ id: 'run-orphan', itemId: 'gone', projectId: 'p', step: 'IN_PROGRESS', actor: 'worker', harness: 'pi', model: 'm', status: 'running', startedAt: new Date().toISOString() });
    for (const project of ['p', 'q', null]) {
      expect((await request(app).patch('/agent-runs/run-orphan').set(marked(project)).send({ status: 'done' })).status, String(project)).toBe(200);
    }
  });
});

const echo2 = (req: any, res: any) => res.json({ covered: !!req.airlockSession });

describe('host terminals (BUG 794bb674, epic review)', () => {
  it('a marked request to a herdr or terminal-session route is refused, and never reaches it', async () => {
    const cases: Array<[string, string]> = [
      ['get', '/herdr/sessions'], ['post', '/herdr/panes/p1/text'], ['post', '/herdr/panes/p1/keys'], ['get', '/herdr/panes/p1/content'],
      ['post', '/terminal-sessions'], ['get', '/terminal-sessions'], ['delete', '/terminal-sessions/t1'], ['post', '/HERDR/panes/p1/keys/'],
    ];
    for (const [m, p] of cases) {
      const res = await (request(app) as any)[m](p).set(marked()).send({});
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(res.body.error).toBe('AIRLOCK_HOST_TERMINAL');
    }
  });

  it('an unmarked request (the board, the CLI outside the sandbox) still reaches them', async () => {
    expect((await request(app).post('/herdr/panes/p1/keys').send({})).status).toBe(200);
    expect((await request(app).get('/terminal-sessions')).status).toBe(200);
  });
});

describe('Airlock\'s own records (da69b17a review)', () => {
  // Approvals and decisions carry other sessions' ids, and a grant is scoped by the session id the
  // caller states: a launch that could list them could spend a grant a person gave another launch.
  it('a marked request cannot list or answer approvals, read decisions or reach learning', async () => {
    for (const r of ['/airlock/approvals', '/airlock/decisions', '/airlock/learning', '/airlock/approvals/k1/grant', '/airlock/learning/import', '/AIRLOCK/Decisions/']) app.all(r, echo2);
    const cases: Array<[string, string]> = [
      ['get', '/airlock/approvals'], ['head', '/airlock/approvals'], ['get', '/airlock/decisions?itemId=t1'], ['get', '/airlock/learning'],
      ['post', '/airlock/approvals/k1/grant'], ['post', '/airlock/learning/import'], ['get', '/AIRLOCK/Decisions/'],
    ];
    for (const project of ['p', null]) {
      for (const [m, p] of cases) {
        const res = await (request(app) as any)[m](p).set(marked(project)).send();
        expect(res.status, `${m} ${p}`).toBe(403);
        if (m !== 'head') expect(res.body.error, `${m} ${p}`).toBe('AIRLOCK_RECORDS');
      }
    }
  });

  it('unmarked (the board, the CLI on the host) still reads them; a marked request still reaches evaluate', async () => {
    app.get('/airlock/approvals', echo2); app.get('/airlock/decisions', echo2); app.post('/airlock/evaluate', echo2);
    expect((await request(app).get('/airlock/approvals')).status).toBe(200);
    expect((await request(app).get('/airlock/decisions')).status).toBe(200);
    expect((await request(app).post('/airlock/evaluate').set(marked()).send({})).status).toBe(200);
  });
});

describe('project commands (BUG d4a53bf5)', () => {
  it('a marked request cannot set its project\'s verify, setup or test-report command, or reach /internal', async () => {
    const cases: Array<[string, string]> = [
      ['put', '/projects/p/verify-command'], ['put', '/projects/p/setup-command'], ['put', '/projects/p/test-report'],
      ['put', '/Projects/p/Verify-Command/'], ['post', '/internal/hub/reload'],
      ['post', '/flows'], ['put', '/flows/f1'], ['delete', '/flows/f1'], ['post', '/projects/p/flow'], ['post', '/projects/p/flow/select-org'], ['post', '/registry/flows/install'],
    ];
    for (const [m, p] of cases) {
      const res = await (request(app) as any)[m](p).set(marked()).send({});
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(res.body.error).toBe('AIRLOCK_PROJECT_COMMAND');
    }
  });

  it('unmarked (a person, the CLI outside the sandbox) still can', async () => {
    expect((await request(app).put('/projects/p/verify-command').send({})).status).toBe(200);
    expect((await request(app).post('/internal/hub/reload').send({})).status).toBe(200);
    expect((await request(app).put('/flows/f1').send({})).status).toBe(200);
  });

  it('a marked request still reads a flow', async () => {
    expect((await request(app).get('/flows/f1').set(marked())).status).toBe(200);
  });
});
