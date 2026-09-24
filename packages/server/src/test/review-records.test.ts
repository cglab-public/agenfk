/**
 * @file CGLAB-381 (S5-T1) — recording an independent review.
 *
 * `POST /items/:id/review-records` stores who reviewed what: the reviewer's
 * identity, the commit range reviewed, and each finding's fate. The identity
 * is READ FROM THE REVIEWER'S TRANSCRIPT, never taken from the request: a
 * Claude Code sub-agent's transcript carries its session and its agent id, a
 * fresh session its own session id. The server reads transcripts only under
 * the harnesses' own session folders, so a record is never a way to read an
 * arbitrary file. A transcript last written before the range's tip commit
 * cannot have reviewed it.
 *
 * verify also records WHO advanced the card (the author identity the CLI
 * reports from its harness), which S5-T2's check compares the reviewer with.
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

const TEST_DB = path.resolve('./review-records-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';
import { bindRoleLessDefaultFlow } from './helpers/roleLessFlow';

let __server: import('http').Server;
const agent = () => request(__server);
const cleanup: string[] = [];
const savedHome = process.env.HOME;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-review-home-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-review-repo-'));
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
async function cardIn(dir: string) {
  const p = await agent().post('/projects').send({ name: `review-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: dir } as never);
  await bindRoleLessDefaultFlow(storage, p.body.id);
  const c = await agent().post('/items').send({ type: 'STORY', title: `card-${++seq}`, projectId: p.body.id });
  return c.body.id as string;
}
const record = (id: string, body: Record<string, unknown>) =>
  agent().post(`/items/${id}/review-records`).set(internal()).send(body);
const FUTURE = '2099-01-01T00:00:00.000Z';
const findings = [{ title: 'null deref in x', state: 'fixed' }, { title: 'rename y', state: 'rejected', reason: 'out of scope' }];

describe('CGLAB-381: review records', () => {
  it('records a review, taking the reviewer identity from a Claude Code sub-agent transcript', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const transcript = claudeSubagentTranscript('sess-A', 'agent123', FUTURE);
    const res = await record(id, { transcript, range: `${base}..${tip}`, findings, reviewer: { sessionId: 'forged', agentId: 'forged' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.reviewer).toMatchObject({ client: 'claude-code', sessionId: 'sess-A', agentId: 'agent123' });
    expect(res.body.range).toEqual({ from: base, to: tip });
    expect(res.body.findings).toEqual(findings);
    const got = (await agent().get(`/items/${id}`)).body;
    expect(got.reviewRecords).toHaveLength(1);
    expect(got.reviewRecords[0].reviewer.sessionId).toBe('sess-A');
  });

  it('reads a pi session transcript as a session of its own, with no agent id', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const res = await record(id, { transcript: piTranscript('pi-sess-9', FUTURE), range: `${base}..${tip}`, findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.reviewer).toMatchObject({ client: 'pi', sessionId: 'pi-sess-9', agentId: null });
  });

  it('refuses a transcript outside the harness session folders', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const stray = path.join(dir, 'fake.jsonl');
    fs.writeFileSync(stray, line({ sessionId: 's', timestamp: FUTURE }));
    const res = await record(id, { transcript: stray, range: `${base}..${tip}`, findings: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session folder|not a transcript/i);
  });

  it('refuses a symlink inside a session folder that points outside it', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const target = path.join(dir, 'outside.jsonl');
    fs.writeFileSync(target, line({ sessionId: 's', timestamp: FUTURE }));
    const link = path.join(home, '.claude', 'projects', '-repo', 'link.jsonl');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    expect((await record(id, { transcript: link, range: `${base}..${tip}`, findings: [] })).status).toBe(400);
  });

  it('refuses a transcript last written before the range\'s tip commit: it cannot have reviewed it', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const res = await record(id, { transcript: claudeSubagentTranscript('sess-B', 'agentOld', '2000-01-01T00:00:00.000Z'), range: `${base}..${tip}`, findings: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/before/);
  });

  it('refuses a range the card\'s tree does not have, or one that is not a from..to pair', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const t = claudeSubagentTranscript('sess-C', 'agentC', FUTURE);
    expect((await record(id, { transcript: t, range: `${base}..deadbeef`, findings: [] })).status).toBe(400);
    expect((await record(id, { transcript: t, range: base, findings: [] })).status).toBe(400);
    const reversed = await record(id, { transcript: t, range: `${tip}..${base}`, findings: [] });
    expect(reversed.status).toBe(400);
    expect(reversed.body.error).toMatch(/ancestor/);
  });

  it('refuses findings that are not fixed or rejected-with-a-reason', async () => {
    const { dir, base, tip } = makeRepo();
    const id = await cardIn(dir);
    const t = claudeSubagentTranscript('sess-D', 'agentD', FUTURE);
    for (const bad of [[{ title: 'x', state: 'open' }], [{ title: 'x', state: 'rejected' }], [{ state: 'fixed' }], 'nope']) {
      const res = await record(id, { transcript: t, range: `${base}..${tip}`, findings: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('requires the internal token', async () => {
    const { dir } = makeRepo();
    const id = await cardIn(dir);
    expect((await agent().post(`/items/${id}/review-records`).send({})).status).toBe(401);
  });

  it('cannot be written through PUT /items/:id', async () => {
    const { dir } = makeRepo();
    const id = await cardIn(dir);
    await agent().put(`/items/${id}`).send({ reviewRecords: [{ reviewer: { sessionId: 'x' } }] });
    expect((await agent().get(`/items/${id}`)).body.reviewRecords).toBeUndefined();
  });

  it('verify records the author identity the caller reports on the step record it writes', async () => {
    const { dir } = makeRepo();
    const id = await cardIn(dir);
    await storage.updateItem(id, { status: 'IN_PROGRESS' } as any);
    const res = await agent().post(`/items/${id}/validate`).set(internal())
      .send({ evidence: 'ok', actor: { client: 'claude-code', sessionId: 'author-sess' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const exit = (await agent().get(`/items/${id}`)).body.stepRecords.find((r: any) => r.kind === 'exit' && r.step === 'IN_PROGRESS');
    expect(exit.actor).toEqual({ client: 'claude-code', sessionId: 'author-sess', agentId: null });
  });

  it('verify ignores a malformed actor rather than storing it', async () => {
    const { dir } = makeRepo();
    const id = await cardIn(dir);
    await storage.updateItem(id, { status: 'IN_PROGRESS' } as any);
    await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok', actor: { sessionId: 42 } });
    const exit = (await agent().get(`/items/${id}`)).body.stepRecords.find((r: any) => r.kind === 'exit');
    expect(exit.actor).toBeUndefined();
  });
});
