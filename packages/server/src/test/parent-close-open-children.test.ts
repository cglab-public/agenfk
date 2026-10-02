/**
 * 8024f6c4: BUG 759b606c reached DONE with two of its children still in TODO -
 * its close accepted while the work it stood for did not exist. The parent
 * roll-up (syncParentStatus) mirrors the LEAST advanced child and is not the
 * cause; the close came from a verify on the parent itself, and nothing in
 * verify asked whether the card still had open children.
 *
 * A card's final move is now refused while a direct child is unfinished.
 * Finished: on the flow's last step, or trashed, archived, or parked as an
 * idea. Refused before any check or suite runs.
 */
import { testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('parent-close-open-children-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const repos: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-parentclose-'));
  repos.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m one', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function setupWith(steps: any[], extra: Record<string, unknown> = {}) {
  const f = await agent().post('/flows').send({ name: `pc-${++seq}`, steps });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `pc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo(), verifyCommand: 'true', ...extra } as never);
  return p.body.id as string;
}
async function follow(id: string): Promise<{ status: number; body: any }> {
  const r = await agent().post(`/items/${id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'ok', async: true });
  if (r.status !== 202) return { status: r.status, body: r.body };
  for (let i = 0; i < 800; i++) {
    const run = await agent().get(`/items/validate-runs/${r.body.runId}`).set('x-agenfk-internal', VERIFY_TOKEN!);
    if (run.body.finishedAt) return { status: run.body.status === 'passed' ? 200 : 400, body: run.body };
    await new Promise(res => setTimeout(res, 25));
  }
  throw new Error('the run never finished');
}
async function setup() {
  const f = await agent().post('/flows').send({ name: `pc-${++seq}`, steps: [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `pc-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo(), verifyCommand: 'true' } as never);
  return p.body.id as string;
}
async function card(projectId: string, status: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `card-${++seq}`, projectId });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string) =>
  agent().post(`/items/${id}/validate`).set('x-agenfk-internal', VERIFY_TOKEN!).send({ evidence: 'ok' });

describe("a card's final move while it has open children", () => {
  it('is refused, naming the children still open - and the card stays put', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    const open = await card(pid, 'START', { parentId: parent });
    await card(pid, 'END', { parentId: parent });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.children.map((c: { id: string }) => c.id)).toEqual([open]);
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('goes through once every child is finished - closed, trashed, archived or parked as an idea', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    for (const status of ['END', 'TRASHED', 'ARCHIVED', 'IDEAS']) await card(pid, status, { parentId: parent });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect((await storage.getItem(parent))?.status).toBe('END');
  });

  it('does not hold up a card with no children at all', async () => {
    const pid = await setup();
    const id = await card(pid, 'WORK');
    const res = await validate(id);
    expect(res.body.error, JSON.stringify(res.body)).toBeUndefined();
    expect((await storage.getItem(id))?.status).toBe('END');
  });

  /*
   * A BARRIER, not a delay: the command says when it started and waits to be
   * released, so the children are created after the entry guard has passed and
   * before the suite ends - on every machine, however loaded.
   */
  it('sees work that appears while the close is running, and refuses at the write with every card named', async () => {
    const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-parentclose-gate-'));
    repos.push(gate);
    const started = path.join(gate, 'started');
    const release = path.join(gate, 'release');
    const pid = await setupWith(
      [s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })],
      { verifyCommand: `touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done` },
    );
    const parent = await card(pid, 'WORK');
    const run = follow(parent);
    // Settled however the test ends: a failure before the release must not
    // leave the command waiting on a barrier nobody will raise.
    const settled = run.then(r => r, (e: unknown) => ({ status: 0, body: { error: String(e) } }));
    const late: string[] = [];
    let res: { status: number; body: any };
    try {
      for (let i = 0; i < 400 && !fs.existsSync(started); i++) await new Promise(r => setTimeout(r, 25));
      expect(fs.existsSync(started), 'the verify command never started').toBe(true);
      // Eleven: more than the message lists, so the structured list is what names them all.
      for (let i = 0; i < 11; i++) late.push(await card(pid, 'START', { parentId: parent }));
    } finally {
      fs.writeFileSync(release, '');
      res = await settled;
    }
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.children.map((c: { id: string }) => c.id).sort()).toEqual([...late].sort());
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('on a flow whose last step is ordinary work, only leaving THAT step closes - and a child on it is not finished', async () => {
    const pid = await setupWith([s('START', 0, { isAnchor: true }), s('WORK', 1), s('CHECK', 2)]);
    // WORK -> CHECK ends nothing: an open child does not hold it.
    const walking = await card(pid, 'WORK');
    await card(pid, 'START', { parentId: walking });
    const walked = await validate(walking);
    expect(walked.status, JSON.stringify(walked.body)).toBe(200);
    expect((await storage.getItem(walking))?.status).toBe('CHECK');
    // CHECK -> DONE closes: a child still working on CHECK holds it.
    const closing = await card(pid, 'CHECK');
    await card(pid, 'CHECK', { parentId: closing });
    expect((await validate(closing)).body.error).toBe('CHILDREN_OPEN');
  });

  it("judges a moved child by its own project's flow", async () => {
    const pid = await setup();
    const other = await setupWith([s('START', 0, { isAnchor: true }), s('WORK', 1), s('SHIPPED', 2, { isAnchor: true })]);
    const parent = await card(pid, 'WORK');
    // Finished where it now lives: SHIPPED ends its flow, whatever the parent's flow calls its end.
    await card(other, 'SHIPPED', { parentId: parent });
    const res = await validate(parent);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storage.getItem(parent))?.status).toBe('END');
  });

  it('does not let the parent roll-up close the parent over a paused child', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    await card(pid, 'END', { parentId: parent });
    const paused = await card(pid, 'PAUSED', { parentId: parent });
    // Any update to a child re-runs the roll-up.
    await agent().put(`/items/${paused}`).send({ title: 'still paused' });
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('holds the close for open work deeper down, under a child that is finished', async () => {
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    const child = await card(pid, 'END', { parentId: parent });
    const grandchild = await card(pid, 'START', { parentId: child });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.children.map((c: { id: string }) => c.id)).toEqual([grandchild]);
  });

  it('holds the close for open work under a child parked as an idea', async () => {
    // Parking a card does not park what is under it.
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    const parked = await card(pid, 'IDEAS', { parentId: parent });
    const working = await card(pid, 'WORK', { parentId: parked });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.children.map((c: { id: string }) => c.id)).toEqual([working]);
  });

  it('refuses rather than closes when the tree is deeper than it can check', async () => {
    // An unfinished card past the depth bound is not "nothing open": an
    // incomplete scan cannot authorize a close.
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    let under = parent;
    for (let i = 0; i < 33; i++) under = await card(pid, 'END', { parentId: under });
    await card(pid, 'START', { parentId: under });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect(res.body.message).toMatch(/not all of it could be checked/i);
    expect((await storage.getItem(parent))?.status).toBe('WORK');
  });

  it('lets the roll-up close the parent once the last open grandchild finishes', async () => {
    // The close was held for the grandchild; finishing it changes nothing on
    // the (already finished) child, and the roll-up used to stop there.
    const pid = await setup();
    const root = await card(pid, 'WORK');
    const child = await card(pid, 'END', { parentId: root });
    const grandchild = await card(pid, 'START', { parentId: child });
    expect((await validate(root)).body.error).toBe('CHILDREN_OPEN');
    // Finished the way cards finish - through verify - not by a write and a
    // rename: an edit that finishes nothing must not close anything (below).
    expect((await validate(grandchild)).status).toBe(200);
    expect((await validate(grandchild)).status).toBe(200);
    expect((await storage.getItem(grandchild))?.status).toBe('END');
    expect((await storage.getItem(root))?.status).toBe('END');
  });

  it('guards the close the first anchor makes, judged on the step it writes', async () => {
    // START -> WAIT (special) -> DONE: the anchor's coding step is DONE, two
    // steps on, so "does the NEXT step end the flow" said no.
    const pid = await setupWith([s('START', 0, { isAnchor: true }), s('WAIT', 1, { isSpecial: true }), s('DONE', 2)]);
    const parent = await card(pid, 'START');
    await card(pid, 'START', { parentId: parent });
    const res = await validate(parent);
    expect(res.body.error, JSON.stringify(res.body)).toBe('CHILDREN_OPEN');
    expect((await storage.getItem(parent))?.status).toBe('START');
  });

  it('closes a tree exactly as deep as it can check', async () => {
    // At the bound with nothing further down, the scan saw everything.
    const pid = await setup();
    const parent = await card(pid, 'WORK');
    let under = parent;
    for (let i = 0; i < 32; i++) under = await card(pid, 'END', { parentId: under });
    const res = await validate(parent);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storage.getItem(parent))?.status).toBe('END');
  });

  it('lets the roll-up close the parent once the last open grandchild is trashed, or archived', async () => {
    const pid = await setup();
    for (const how of ['trash', 'archive'] as const) {
      const root = await card(pid, 'WORK');
      const child = await card(pid, 'END', { parentId: root });
      const grandchild = await card(pid, 'START', { parentId: child });
      expect((await validate(root)).body.error).toBe('CHILDREN_OPEN');
      if (how === 'trash') await agent().delete(`/items/${grandchild}`);
      else await agent().put(`/items/${grandchild}`).send({ status: 'ARCHIVED' });
      expect((await storage.getItem(root))?.status, how).toBe('END');
    }
  });

  it('does not re-close an ancestor somebody reopened, on an edit that finishes nothing', async () => {
    const pid = await setup();
    const root = await card(pid, 'END');
    const child = await card(pid, 'END', { parentId: root });
    const grandchild = await card(pid, 'END', { parentId: child });
    await storage.updateItem(root, { status: 'WORK' } as any);
    await agent().put(`/items/${grandchild}`).send({ title: 'renamed' });
    expect((await storage.getItem(root))?.status).toBe('WORK');
  });

  it('ends the roll-up on a parent cycle left in old data', async () => {
    const pid = await setup();
    const a = await card(pid, 'END');
    const b = await card(pid, 'END', { parentId: a });
    await storage.updateItem(a, { parentId: b } as any);
    const leaf = await card(pid, 'START', { parentId: a });
    // A release under a finished parent walks up: around the cycle once, then stops.
    const res = await agent().delete(`/items/${leaf}`);
    expect(res.status).toBeLessThan(500);
  }, 10_000);
});
