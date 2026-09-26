/**
 * @file CGLAB-377 (S1 of the flow-adherence epic) — forward moves go through
 * `agenfk verify`, and nothing else.
 *
 * Before this, `PUT /items/:id` and `POST /items/bulk` allowed a move one step
 * FORWARD, so `agenfk update <id> --status <next>` walked a card to the step
 * before DONE with no evidence and no command. And the `x-agenfk-internal`
 * token — a file any same-user agent can read — skipped both the transition
 * table and the DONE ban, so one request could land DONE from anywhere.
 *
 * Contract under test:
 *  - a forward move on PUT or bulk is refused, naming `agenfk verify`; the
 *    card stays where it was;
 *  - the internal token no longer changes that, and no longer reaches DONE;
 *  - backward moves and platform statuses (PAUSED) still work, and a backward
 *    move is recorded on the card;
 *  - the board (x-agenfk-ui) may still drag a card ONE step forward — the
 *    user's decision — and every such move is recorded on the card as a
 *    manual move with no evidence; the board still can't reach DONE or skip
 *    a step;
 *  - `POST /items/:id/validate` still advances the card;
 *  - all of it holds on the flow shapes the rest of the server already knows:
 *    boundary steps marked only `isSpecial` (what `agenfk flow create` makes),
 *    an exit step not named DONE, a mid-flow held step, and a last step that
 *    is not a boundary — and a platform status (PAUSED, ARCHIVED...) is not a
 *    detour past the entry step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./forward-only-via-verify-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Import AFTER the env var so storage lands in the test DB.
import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(() => { __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const board = () => ({ 'x-agenfk-ui': '1' });

const TDD_STEPS = [
  { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { name: 'DISCOVERY', label: 'Discovery', order: 1 },
  { name: 'CREATE_UNIT_TESTS', label: 'Unit Tests', order: 2 },
  { name: 'IN_PROGRESS', label: 'In Progress', order: 3 },
  { name: 'REVIEW', label: 'Review', order: 4 },
  { name: 'DONE', label: 'Done', order: 5, isAnchor: true },
];

let seq = 0;
/**
 * A TASK on the TDD flow, parked on `status` through storage — the one route
 * that is not under test here, so the setup can't pass or fail for the
 * reason the test is about.
 */
async function cardOn(status: string) {
  return cardOnFlow(TDD_STEPS, status);
}

async function cardOnFlow(steps: Array<Record<string, unknown>>, status: string) {
  const name = `fwd-${++seq}`;
  const project = await agent().post('/projects').send({ name });
  expect(project.status, `project: ${JSON.stringify(project.body)}`).toBe(201);
  const flow = await agent().post('/flows').set(internal()).send({ name: `${name}-flow`, steps });
  expect(flow.status, `flow: ${JSON.stringify(flow.body)}`).toBe(201);
  const use = await agent().post(`/projects/${project.body.id}/flow`).set(internal()).send({ flowId: flow.body.id });
  expect(use.status, `use flow: ${JSON.stringify(use.body)}`).toBe(200);
  const created = await agent().post('/items').send({ type: 'TASK', title: `${name}-item`, projectId: project.body.id });
  expect(created.status, `item: ${JSON.stringify(created.body)}`).toBe(201);
  await storage.updateItem(created.body.id, { status } as any);
  const readBack = await agent().get(`/items/${created.body.id}`);
  expect(readBack.body.status, `fixture: the card is not on ${status}`).toBe(status);
  return readBack.body;
}

async function statusOf(id: string) {
  return (await agent().get(`/items/${id}`)).body.status;
}
async function commentsOf(id: string): Promise<Array<{ author: string; content: string }>> {
  return (await agent().get(`/items/${id}`)).body.comments ?? [];
}

describe('CGLAB-377: forward moves only via verify', () => {
  beforeEach(async () => { await initStorage(); });

  describe('PUT /items/:id', () => {
    it('refuses a one-step forward move and leaves the card where it was', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'IN_PROGRESS' });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('agenfk verify');
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
    });

    it('refuses the forward move out of TODO too', async () => {
      const card = await cardOn('TODO');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'DISCOVERY' });
      expect(res.status).toBe(409);
      expect(await statusOf(card.id)).toBe('TODO');
    });

    it('refuses a forward move even with the internal token', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().put(`/items/${card.id}`).set(internal()).send({ status: 'IN_PROGRESS' });
      expect(res.status).toBe(409);
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
    });

    it('refuses DONE with the internal token, from the step before it', async () => {
      const card = await cardOn('REVIEW');
      const res = await agent().put(`/items/${card.id}`).set(internal()).send({ status: 'DONE' });
      expect(res.status).toBe(403);
      expect(await statusOf(card.id)).toBe('REVIEW');
    });

    it('refuses the internal token a multi-step jump', async () => {
      const card = await cardOn('DISCOVERY');
      const res = await agent().put(`/items/${card.id}`).set(internal()).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('DISCOVERY');
    });

    it('still allows a backward move, and records it on the card', async () => {
      const card = await cardOn('IN_PROGRESS');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'CREATE_UNIT_TESTS' });
      expect(res.status).toBe(200);
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
      const moved = (await commentsOf(card.id)).filter(c => /Moved back/.test(c.content));
      expect(moved).toHaveLength(1);
      expect(moved[0].content).toContain('IN_PROGRESS');
      expect(moved[0].content).toContain('CREATE_UNIT_TESTS');
    });

    it('still allows a platform status', async () => {
      const card = await cardOn('IN_PROGRESS');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'PAUSED' });
      expect(res.status).toBe(200);
      expect(await statusOf(card.id)).toBe('PAUSED');
    });

    it('lets the board drag one step forward, and records it as a manual move', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().put(`/items/${card.id}`).set(board()).send({ status: 'IN_PROGRESS' });
      expect(res.status).toBe(200);
      expect(await statusOf(card.id)).toBe('IN_PROGRESS');
      const manual = (await commentsOf(card.id)).filter(c => c.author === 'Board');
      expect(manual).toHaveLength(1);
      expect(manual[0].content).toContain('CREATE_UNIT_TESTS');
      expect(manual[0].content).toContain('IN_PROGRESS');
      expect(manual[0].content).toMatch(/without agenfk verify/i);
    });

    it('does not record a manual move when the board only edits the title', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().put(`/items/${card.id}`).set(board()).send({ title: 'renamed', status: 'CREATE_UNIT_TESTS' });
      expect(res.status).toBe(200);
      expect((await commentsOf(card.id)).filter(c => c.author === 'Board')).toHaveLength(0);
    });

    it('does not let the board skip a step', async () => {
      const card = await cardOn('DISCOVERY');
      const res = await agent().put(`/items/${card.id}`).set(board()).send({ status: 'IN_PROGRESS' });
      expect(res.status).toBe(400);
      expect(await statusOf(card.id)).toBe('DISCOVERY');
    });

    it('does not let the board reach DONE', async () => {
      const card = await cardOn('REVIEW');
      const res = await agent().put(`/items/${card.id}`).set(board()).send({ status: 'DONE' });
      expect(res.status).toBe(403);
      expect(await statusOf(card.id)).toBe('REVIEW');
    });
  });

  describe('POST /items/bulk', () => {
    it('skips a forward entry and leaves the card where it was', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().post('/items/bulk').send({ items: [{ id: card.id, updates: { status: 'IN_PROGRESS' } }] });
      expect(res.status).toBe(200);
      expect(res.body.skipped?.map((s: any) => s.id)).toContain(card.id);
      expect(res.body.skipped.find((s: any) => s.id === card.id).error).toContain('agenfk verify');
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
    });

    it('skips a forward entry even with the internal token', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().post('/items/bulk').set(internal()).send({ items: [{ id: card.id, updates: { status: 'IN_PROGRESS' } }] });
      expect(res.body.skipped?.map((s: any) => s.id)).toContain(card.id);
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
    });

    it('skips DONE even with the internal token', async () => {
      const card = await cardOn('REVIEW');
      const res = await agent().post('/items/bulk').set(internal()).send({ items: [{ id: card.id, updates: { status: 'DONE' } }] });
      expect(res.body.skipped?.map((s: any) => s.id)).toContain(card.id);
      expect(await statusOf(card.id)).toBe('REVIEW');
    });

    it('still applies a backward entry, and records it on the card', async () => {
      const card = await cardOn('IN_PROGRESS');
      const res = await agent().post('/items/bulk').send({ items: [{ id: card.id, updates: { status: 'CREATE_UNIT_TESTS' } }] });
      expect(res.status).toBe(200);
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
      expect((await commentsOf(card.id)).filter(c => /Moved back/.test(c.content))).toHaveLength(1);
    });

    it('lets the board move one step forward in a bulk reorder, recorded as a manual move', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().post('/items/bulk').set(board())
        .send({ items: [{ id: card.id, updates: { status: 'IN_PROGRESS', sortOrder: 0 } }] });
      expect(res.status).toBe(200);
      expect(await statusOf(card.id)).toBe('IN_PROGRESS');
      expect((await commentsOf(card.id)).filter(c => c.author === 'Board')).toHaveLength(1);
    });
  });

  // The shape `agenfk flow create` produces: boundary steps marked only
  // isSpecial, never isAnchor, and an exit step with its own name.
  const CLI_STEPS = [
    { name: 'BACKLOG', label: 'Backlog', order: 0, isSpecial: true },
    { name: 'BUILDING', label: 'Building', order: 1 },
    { name: 'CHECKING', label: 'Checking', order: 2 },
    { name: 'SHIPPED', label: 'Shipped', order: 3, isSpecial: true },
  ];

  describe('on a CLI-authored flow (isSpecial boundaries, exit not named DONE)', () => {
    it('refuses a plain PUT onto the exit step', async () => {
      const card = await cardOnFlow(CLI_STEPS, 'CHECKING');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'SHIPPED' });
      expect(res.status).toBe(403);
      expect(await statusOf(card.id)).toBe('CHECKING');
    });

    it('refuses the board the exit step too', async () => {
      const card = await cardOnFlow(CLI_STEPS, 'CHECKING');
      const res = await agent().put(`/items/${card.id}`).set(board()).send({ status: 'SHIPPED' });
      expect(res.status).toBe(403);
      expect(await statusOf(card.id)).toBe('CHECKING');
    });

    it('skips a bulk move onto the exit step', async () => {
      const card = await cardOnFlow(CLI_STEPS, 'CHECKING');
      const res = await agent().post('/items/bulk').set(board()).send({ items: [{ id: card.id, updates: { status: 'SHIPPED' } }] });
      expect(res.body.skipped?.map((x: any) => x.id)).toContain(card.id);
      expect(await statusOf(card.id)).toBe('CHECKING');
    });

    it('refuses an agent the move off the entry boundary, and records the board doing it', async () => {
      const card = await cardOnFlow(CLI_STEPS, 'BACKLOG');
      expect((await agent().put(`/items/${card.id}`).send({ status: 'BUILDING' })).status).toBe(409);
      expect(await statusOf(card.id)).toBe('BACKLOG');
      expect((await agent().put(`/items/${card.id}`).set(board()).send({ status: 'BUILDING' })).status).toBe(200);
      expect((await commentsOf(card.id)).filter(c => c.author === 'Board')).toHaveLength(1);
    });

    it('records a move back off the exit step', async () => {
      const card = await cardOnFlow(CLI_STEPS, 'SHIPPED');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'CHECKING' });
      expect(res.status).toBe(200);
      expect((await commentsOf(card.id)).filter(c => /Moved back/.test(c.content))).toHaveLength(1);
    });
  });

  describe('other flow shapes', () => {
    it('refuses the board a custom-named anchor exit step', async () => {
      const card = await cardOnFlow([
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'A', label: 'A', order: 1 },
        { name: 'SHIP', label: 'Ship', order: 2, isAnchor: true },
      ], 'A');
      const res = await agent().put(`/items/${card.id}`).set(board()).send({ status: 'SHIP' });
      expect(res.status).toBe(403);
      expect(await statusOf(card.id)).toBe('A');
    });

    it('treats a move onto a mid-flow held step as forward', async () => {
      const steps = [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'SPEC', label: 'Spec', order: 1 },
        { name: 'HOLD', label: 'Hold', order: 2, isSpecial: true },
        { name: 'CODE', label: 'Code', order: 3 },
        { name: 'SHIPPED', label: 'Shipped', order: 4, isAnchor: true },
      ];
      const card = await cardOnFlow(steps, 'SPEC');
      expect((await agent().put(`/items/${card.id}`).send({ status: 'HOLD' })).status).toBe(409);
      expect(await statusOf(card.id)).toBe('SPEC');
      // Held is not finished: the board may still drag onto it.
      expect((await agent().put(`/items/${card.id}`).set(board()).send({ status: 'HOLD' })).status).toBe(200);
    });

    it('lets the board reach a last step that is not a boundary: it is still work, not completion', async () => {
      const card = await cardOnFlow([
        { name: 'ONE', label: 'One', order: 0 },
        { name: 'TWO', label: 'Two', order: 1 },
        { name: 'THREE', label: 'Three', order: 2 },
      ], 'TWO');
      expect((await agent().put(`/items/${card.id}`).send({ status: 'THREE' })).status).toBe(409);
      expect((await agent().put(`/items/${card.id}`).set(board()).send({ status: 'THREE' })).status).toBe(200);
    });
  });

  describe('a platform status is not a detour past the entry step', () => {
    it('refuses PAUSED -> the step after the entry', async () => {
      const card = await cardOn('PAUSED');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'DISCOVERY' });
      expect(res.status).toBe(409);
      expect(await statusOf(card.id)).toBe('PAUSED');
    });

    it('refuses ARCHIVED -> the step after the entry (the unarchive path)', async () => {
      const card = await cardOn('ARCHIVED');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'DISCOVERY' });
      expect(res.status).toBe(409);
      expect(await statusOf(card.id)).toBe('ARCHIVED');
    });

    it('refuses a status the flow does not know -> the step after the entry', async () => {
      const card = await cardOn('NOT_IN_THIS_FLOW');
      const res = await agent().put(`/items/${card.id}`).send({ status: 'DISCOVERY' });
      expect(res.status).toBe(409);
    });

    it('still allows PAUSED and ARCHIVED back to the entry step', async () => {
      const paused = await cardOn('PAUSED');
      expect((await agent().put(`/items/${paused.id}`).send({ status: 'TODO' })).status).toBe(200);
      const archived = await cardOn('ARCHIVED');
      expect((await agent().put(`/items/${archived.id}`).send({ status: 'TODO' })).status).toBe(200);
      expect(await statusOf(archived.id)).toBe('TODO');
    });

    it('lets the board make that move, and records it', async () => {
      const card = await cardOn('PAUSED');
      expect((await agent().put(`/items/${card.id}`).set(board()).send({ status: 'DISCOVERY' })).status).toBe(200);
      expect((await commentsOf(card.id)).filter(c => c.author === 'Board')).toHaveLength(1);
    });

    it('refuses the same detour on the bulk route', async () => {
      const card = await cardOn('PAUSED');
      const res = await agent().post('/items/bulk').send({ items: [{ id: card.id, updates: { status: 'DISCOVERY' } }] });
      expect(res.body.skipped?.map((x: any) => x.id)).toContain(card.id);
      expect(await statusOf(card.id)).toBe('PAUSED');
    });
  });

  describe('returning from a platform status', () => {
    // User decision (CGLAB-377 review round 2): a card may go back to the step
    // it left when it entered PAUSED/BLOCKED/ARCHIVED, or anywhere earlier,
    // without re-verifying — never further.
    it('lets an agent return a BLOCKED card to the step it left, or earlier', async () => {
      const card = await cardOn('REVIEW');
      expect((await agent().put(`/items/${card.id}`).send({ status: 'BLOCKED' })).status).toBe(200);
      expect((await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' })).status).toBe(200);
      expect(await statusOf(card.id)).toBe('REVIEW');

      const other = await cardOn('REVIEW');
      await agent().put(`/items/${other.id}`).send({ status: 'BLOCKED' });
      expect((await agent().put(`/items/${other.id}`).send({ status: 'IN_PROGRESS' })).status).toBe(200);
    });

    it('never lets it go past the step it left', async () => {
      const card = await cardOn('IN_PROGRESS');
      await agent().put(`/items/${card.id}`).send({ status: 'BLOCKED' });
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('BLOCKED');
    });

    it('keeps the step it left when a BLOCKED card is then PAUSED', async () => {
      const card = await cardOn('REVIEW');
      await agent().put(`/items/${card.id}`).send({ status: 'BLOCKED' });
      await agent().put(`/items/${card.id}`).send({ status: 'PAUSED' });
      expect((await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' })).status).toBe(200);
    });

    it('cannot be used as a ticket: a later entry records the later step', async () => {
      const card = await cardOn('REVIEW');
      await agent().put(`/items/${card.id}`).send({ status: 'BLOCKED' });
      await agent().put(`/items/${card.id}`).send({ status: 'TODO' });
      await agent().put(`/items/${card.id}`).send({ status: 'PAUSED' });
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('PAUSED');
    });

    it('ignores a previousStatus sent in the request body', async () => {
      const card = await cardOn('TODO');
      await agent().put(`/items/${card.id}`).send({ status: 'PAUSED', previousStatus: 'REVIEW' });
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('PAUSED');
    });

    it('records the step it left on the bulk route too', async () => {
      const card = await cardOn('REVIEW');
      await agent().post('/items/bulk').send({ items: [{ id: card.id, updates: { status: 'BLOCKED' } }] });
      expect(await statusOf(card.id)).toBe('BLOCKED');
      const res = await agent().post('/items/bulk').send({ items: [{ id: card.id, updates: { status: 'REVIEW' } }] });
      expect(res.body.skipped ?? []).toHaveLength(0);
      expect(await statusOf(card.id)).toBe('REVIEW');
    });

    it('lets an ARCHIVED card come back to the step it was archived from', async () => {
      const card = await cardOn('REVIEW');
      expect((await agent().put(`/items/${card.id}`).send({ status: 'ARCHIVED' })).status).toBe(200);
      expect((await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' })).status).toBe(200);
      expect(await statusOf(card.id)).toBe('REVIEW');
    });

    it('does not strand a card on a CLI-authored flow: PAUSED/BLOCKED back to where it was, or the entry', async () => {
      const paused = await cardOnFlow(CLI_STEPS, 'BUILDING');
      await agent().put(`/items/${paused.id}`).send({ status: 'PAUSED' });
      expect((await agent().put(`/items/${paused.id}`).send({ status: 'BUILDING' })).status).toBe(200);

      const blocked = await cardOnFlow(CLI_STEPS, 'CHECKING');
      await agent().put(`/items/${blocked.id}`).send({ status: 'BLOCKED' });
      expect((await agent().put(`/items/${blocked.id}`).send({ status: 'BACKLOG' })).status).toBe(200);

      const again = await cardOnFlow(CLI_STEPS, 'CHECKING');
      await agent().put(`/items/${again.id}`).send({ status: 'BLOCKED' });
      expect((await agent().put(`/items/${again.id}`).send({ status: 'CHECKING' })).status).toBe(200);
    });

    it('records a board move out of ARCHIVED past the step it left (PUT and bulk)', async () => {
      const card = await cardOn('TODO');
      await agent().put(`/items/${card.id}`).send({ status: 'ARCHIVED' });
      expect((await agent().put(`/items/${card.id}`).set(board()).send({ status: 'DISCOVERY' })).status).toBe(200);
      expect(await statusOf(card.id)).toBe('DISCOVERY');
      expect((await commentsOf(card.id)).filter(c => c.author === 'Board')).toHaveLength(1);

      const bulk = await cardOn('TODO');
      await agent().put(`/items/${bulk.id}`).send({ status: 'ARCHIVED' });
      await agent().post('/items/bulk').set(board()).send({ items: [{ id: bulk.id, updates: { status: 'DISCOVERY' } }] });
      expect(await statusOf(bulk.id)).toBe('DISCOVERY');
      expect((await commentsOf(bulk.id)).filter(c => c.author === 'Board')).toHaveLength(1);
    });
  });

  describe('the step a card left is single-use (review round 3)', () => {
    const prevOf = async (id: string) => (await agent().get(`/items/${id}`)).body.previousStatus ?? null;
    const pauseBody = { summary: 's', resumeInstructions: 'r' };

    it('is cleared by the return, so a later rollback cannot be undone through IDEAS', async () => {
      const card = await cardOn('REVIEW');
      await agent().put(`/items/${card.id}`).send({ status: 'BLOCKED' });
      expect((await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' })).status).toBe(200);
      expect(await prevOf(card.id)).toBeNull();
      await agent().put(`/items/${card.id}`).send({ status: 'IN_PROGRESS' });
      await agent().put(`/items/${card.id}`).send({ status: 'IDEAS' });
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('IDEAS');
    });

    it('is cleared by any other status move through PUT', async () => {
      const card = await cardOn('REVIEW');
      await storage.updateItem(card.id, { previousStatus: 'REVIEW' } as any);
      await agent().put(`/items/${card.id}`).send({ status: 'IN_PROGRESS' });
      expect(await prevOf(card.id)).toBeNull();
    });

    it('is cleared by a status move through bulk', async () => {
      const card = await cardOn('REVIEW');
      await storage.updateItem(card.id, { previousStatus: 'REVIEW' } as any);
      await agent().post('/items/bulk').send({ items: [{ id: card.id, updates: { status: 'IN_PROGRESS' } }] });
      expect(await prevOf(card.id)).toBeNull();
    });

    it('is never honoured on IDEAS', async () => {
      const card = await cardOn('IDEAS');
      await storage.updateItem(card.id, { previousStatus: 'REVIEW' } as any);
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('IDEAS');
    });

    it('is never honoured on TRASHED (a deleted card cannot come back mid-flow)', async () => {
      const card = await cardOn('TRASHED');
      await storage.updateItem(card.id, { previousStatus: 'REVIEW' } as any);
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('TRASHED');
    });

    it('is cleared by the pause route, which has its own snapshot', async () => {
      const card = await cardOn('IN_PROGRESS');
      await storage.updateItem(card.id, { previousStatus: 'REVIEW' } as any);
      expect((await agent().post(`/items/${card.id}/pause`).send(pauseBody)).status).toBe(200);
      const res = await agent().put(`/items/${card.id}`).send({ status: 'REVIEW' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(card.id)).toBe('PAUSED');
    });

    it('is cleared by the resume route', async () => {
      const card = await cardOn('IN_PROGRESS');
      expect((await agent().post(`/items/${card.id}/pause`).send(pauseBody)).status).toBe(200);
      await storage.updateItem(card.id, { previousStatus: 'REVIEW' } as any);
      expect((await agent().post(`/items/${card.id}/resume`).send({})).status).toBe(200);
      expect(await statusOf(card.id)).toBe('IN_PROGRESS');
      expect(await prevOf(card.id)).toBeNull();
    });
  });

  describe('the board header', () => {
    it('is only the board when it says 1', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().put(`/items/${card.id}`).set('x-agenfk-ui', '0').send({ status: 'IN_PROGRESS' });
      expect(res.status).toBe(409);
      expect(await statusOf(card.id)).toBe('CREATE_UNIT_TESTS');
    });
  });

  describe('verify is the forward route', () => {
    it('POST /items/:id/validate still advances an intermediate step', async () => {
      const card = await cardOn('CREATE_UNIT_TESTS');
      const res = await agent().post(`/items/${card.id}/validate`).set(internal())
        .send({ evidence: 'red tests written' });
      expect(res.status).toBe(200);
      expect(await statusOf(card.id)).toBe('IN_PROGRESS');
    });
  });
});
