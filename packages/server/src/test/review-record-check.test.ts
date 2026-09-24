/**
 * @file CGLAB-381 (S5-T2) — the review-record check.
 *
 * A step with the review role leaves only with an independent review on
 * record: the reviewer (read from its transcript) must differ from every
 * author identity that advanced the card or its descendants; the reviewed
 * range must start where the card's work began and include every
 * descendant's close commit. Reviews happen at the PARENT (user decision
 * 2026-09-23): a child passes with its parent, and a parent whose children all
 * carry reviews (an epic over reviewed stories) needs none of its own.
 */
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

const TEST_DB = path.resolve('./review-record-check-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const cleanup: string[] = [];
const savedHome = process.env.HOME;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-rcheck-home-'));
  cleanup.push(home);
  process.env.HOME = home;
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  process.env.HOME = savedHome;
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/** A repo with two commits; returns both SHAs and the tip's commit time. */
function makeRepo(): { dir: string; base: string; tip: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-rcheck-repo-'));
  cleanup.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const base = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  execSync('git add . && git commit -qm two', { cwd: dir, shell: '/bin/sh' });
  const tip = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, base, tip };
}

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
/** A Claude Code sub-agent transcript under the sandboxed ~/.claude/projects. */
function claudeSubagentTranscript(session: string, agentId: string, lastAt: string): string {
  const dir = path.join(home, '.claude', 'projects', '-repo', session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(f,
    line({ type: 'user', isSidechain: true, agentId, sessionId: session, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'review' } })
    + line({ type: 'assistant', isSidechain: true, agentId, sessionId: session, timestamp: lastAt, message: { role: 'assistant', content: 'findings' } }));
  return f;
}
/** A pi session transcript under ~/.pi/agent/sessions. */
function piTranscript(id: string, lastAt: string): string {
  const dir = path.join(home, '.pi', 'agent', 'sessions', '--repo--');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, line({ type: 'session', id, timestamp: '2026-01-01T00:00:00.000Z' }) + line({ type: 'message', timestamp: lastAt, message: { role: 'assistant' } }));
  return f;
}


let seq = 0;
const FUTURE = '2099-01-01T00:00:00.000Z';
const AUTHOR = { client: 'claude-code', sessionId: 'author-sess', agentId: null };
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

async function setup(reviewChecks?: any[]) {
  const repo = makeRepo();
  const f = await agent().post('/flows').send({ name: `rc-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }), s('WORK', 1, { role: 'planning' }),
    s('LOOK', 2, { role: 'review', ...(reviewChecks ? { checks: reviewChecks } : {}) }), s('END', 3, { isAnchor: true, role: 'closing' }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `rc-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: repo.dir, flowId: f.body.id, verifyCommand: 'exit 0' } as never);
  return { ...repo, pid: p.body.id as string };
}
/** A card at LOOK whose work began at `start`, advanced by AUTHOR. */
async function cardAt(pid: string, start: string, status = 'LOOK', extra: Record<string, unknown> = {}, type = 'STORY') {
  const c = await agent().post('/items').send({ type, title: `card-${++seq}`, projectId: pid });
  await storage.updateItem(c.body.id, { status, stepRecords: [{ step: 'START', kind: 'exit', at: 't', head: start, clean: true, actor: AUTHOR }], ...extra } as any);
  return c.body.id as string;
}
const record = (id: string, transcript: string, range: string, findings: unknown[] = []) =>
  agent().post(`/items/${id}/review-records`).set(internal()).send({ transcript, range, findings });
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const reviewCheck = (body: any) => (body.checks ?? []).find((c: any) => c.id === 'review-record');
const commit = (dir: string, msg: string) => {
  fs.writeFileSync(path.join(dir, `f-${++seq}.txt`), msg);
  execSync(`git add . && git commit -qm "${msg}"`, { cwd: dir, shell: '/bin/sh' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
};

describe('CGLAB-381: the review-record check', () => {
  it('refuses to leave a review step with no review on record', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(reviewCheck(res.body)).toMatchObject({ outcome: 'fail', blocking: true });
    expect(reviewCheck(res.body).detail).toMatch(/agenfk review record/);
  });

  it('passes with a review by a sub-agent of the author\'s session: another agent is independent', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    expect((await record(id, claudeSubagentTranscript('author-sess', 'rev1', FUTURE), `${base}..${tip}`)).status).toBe(201);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses a review whose transcript is the author\'s own thread', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base, 'LOOK', { stepRecords: [{ step: 'START', kind: 'exit', at: 't', head: base, clean: true, actor: { client: 'pi', sessionId: 'pi-author', agentId: null } }] });
    expect((await record(id, piTranscript('pi-author', FUTURE), `${base}..${tip}`)).status).toBe(201);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(reviewCheck(res.body).detail).toMatch(/not independent|author/);
  });

  it('counts authors of the card\'s descendants too', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    const task = await cardAt(pid, base, 'DONE', { parentId: id, stepRecords: [{ step: 'START', kind: 'exit', at: 't', head: base, clean: true, actor: { client: 'pi', sessionId: 'pi-task-author', agentId: null } }] }, 'TASK');
    void task;
    await record(id, piTranscript('pi-task-author', FUTURE), `${base}..${tip}`);
    expect((await validate(id)).status).toBe(422);
  });

  it('refuses a range that starts after the card\'s work began', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    await record(id, claudeSubagentTranscript('author-sess', 'rev2', FUTURE), `${tip}..${tip}`);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(reviewCheck(res.body).detail).toMatch(/began/);
  });

  it('refuses a range that misses a descendant\'s close commit', async () => {
    const { dir, base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    const task = await cardAt(pid, base, 'DONE', { parentId: id }, 'TASK');
    await record(id, claudeSubagentTranscript('author-sess', 'rev3', FUTURE), `${base}..${tip}`);
    const late = commit(dir, `close(task): later [${task}]`);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(reviewCheck(res.body).detail).toContain(late.slice(0, 12));
  });

  it('a child card passes with its parent: reviews happen at the parent', async () => {
    const { base, pid } = await setup();
    const parent = await cardAt(pid, base, 'WORK');
    const child = await cardAt(pid, base, 'LOOK', { parentId: parent }, 'TASK');
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('appliesTo every-card makes a child need its own review', async () => {
    const { base, pid } = await setup([{ id: 'review-record', params: { appliesTo: 'every-card' } }]);
    const parent = await cardAt(pid, base, 'WORK');
    const child = await cardAt(pid, base, 'LOOK', { parentId: parent }, 'TASK');
    expect((await validate(child)).status).toBe(422);
  });

  it('a parent whose children all carry reviews needs none of its own (an epic over reviewed stories)', async () => {
    const { base, tip, pid } = await setup();
    const epic = await cardAt(pid, base, 'LOOK', {}, 'EPIC');
    for (const n of [1, 2]) {
      const story = await cardAt(pid, base, 'DONE', { parentId: epic }, 'STORY');
      expect((await record(story, claudeSubagentTranscript('author-sess', `story-rev-${n}`, FUTURE), `${base}..${tip}`)).status).toBe(201);
    }
    const res = await validate(epic);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('with no author identity recorded, independence cannot be shown: it warns, and says so', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base, 'LOOK', { stepRecords: [{ step: 'START', kind: 'exit', at: 't', head: base, clean: true }] });
    await record(id, claudeSubagentTranscript('someone', 'rev4', FUTURE), `${base}..${tip}`);
    const res = await validate(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = (await agent().get(`/items/${id}`)).body.lastChecks.results.find((c: any) => c.id === 'review-record');
    expect(r).toMatchObject({ outcome: 'unavailable', blocking: false });
  });
});
