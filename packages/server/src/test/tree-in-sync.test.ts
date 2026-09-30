/**
 * @file 1049ce52 — a card leaves the backlog only from a tree in sync with its remote.
 *
 * A session built a card in a checkout 25 commits behind origin: the Clean
 * Start pull is a rule, and a resumed card skipped it. The `tree-in-sync`
 * check (the `backlog` role's) fetches the tree's upstream itself and refuses
 * a tree that is behind it or has diverged from it. Ahead is fine (unpushed
 * work), no remote is fine, and an unreachable remote only warns: offline
 * work is never stranded.
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

const TEST_DB = path.resolve('./tree-in-sync-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim();
const id = 'git config user.email t@t && git config user.name t';

/** A bare origin, the card's clone of it, and a colleague's clone that can push ahead of it. */
function remoteSetup() {
  const origin = tmp('agenfk-sync-origin-');
  sh(origin, 'git init -q --bare -b main');
  const work = tmp('agenfk-sync-work-');
  sh(work, `git clone -q ${origin} . && ${id} && echo a > a && git add . && git commit -qm one && git push -q -u origin main`);
  const other = tmp('agenfk-sync-other-');
  sh(other, `git clone -q ${origin} . && ${id}`);
  const pushFromOther = (f: string) => sh(other, `git pull -q --ff-only && echo ${f} > ${f} && git add ${f} && git commit -qm ${f} && git push -q`);
  const commitHere = (f: string) => sh(work, `echo ${f} > ${f} && git add ${f} && git commit -qm ${f}`);
  return { origin, work, pushFromOther, commitHere };
}

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function card(root: string, todo: Record<string, unknown> = { role: 'backlog' }) {
  const f = await agent().post('/flows').send({ name: `sync-${++seq}`, steps: [s('TODO', 0, { isAnchor: true, ...todo }), s('WORK', 1), s('DONE', 2, { isAnchor: true })] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `sync-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: root, verifyCommand: 'true' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `sync-${++seq}`, projectId: p.body.id });
  return c.body.id as string;
}
const validate = (cid: string) => agent().post(`/items/${cid}/validate`).set(internal()).send({ evidence: 'ok' });
const verdict = (res: any) => (res.body.checks ?? []).find((c: any) => c.id === 'tree-in-sync')
  ?? undefined;
const recorded = async (cid: string) => ((await agent().get(`/items/${cid}`)).body.lastChecks?.results ?? []).find((c: any) => c.id === 'tree-in-sync');

describe('1049ce52: tree-in-sync', () => {
  it('passes a tree in sync with its upstream', async () => {
    const r = remoteSetup();
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await recorded(cid)).toMatchObject({ outcome: 'pass' });
  });

  it('fetches by itself, and refuses a tree behind its upstream, naming the count and the fix', async () => {
    const r = remoteSetup();
    r.pushFromOther('b');
    r.pushFromOther('c');
    // The card's clone has NOT fetched: only a check that fetches can know.
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const v = verdict(res);
    expect(v).toMatchObject({ outcome: 'fail', blocking: true });
    expect(v.detail).toMatch(/2 commits? behind/);
    expect(v.detail).toContain('git pull --ff-only');
  });

  it('passes a tree only ahead of its upstream: unpushed work is fine', async () => {
    const r = remoteSetup();
    r.commitHere('local');
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await recorded(cid)).detail).toMatch(/1 commit ahead/);
  });

  it('refuses a tree that has diverged from its upstream', async () => {
    const r = remoteSetup();
    r.pushFromOther('theirs');
    r.commitHere('mine');
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status).toBe(422);
    expect(verdict(res)).toMatchObject({ outcome: 'fail', blocking: true });
    expect(verdict(res).detail).toMatch(/diverged/);
  });

  it('passes a tree with no remote at all: nothing to be in sync with', async () => {
    const solo = tmp('agenfk-sync-solo-');
    sh(solo, `git init -q -b main && ${id} && echo a > a && git add . && git commit -qm one`);
    const cid = await card(solo);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await recorded(cid)).detail).toMatch(/no upstream|no remote/);
  });

  it('refuses a fresh branch with no upstream that sits behind the remote default branch: a stale base (review)', async () => {
    const r = remoteSetup();
    r.pushFromOther('b');
    // A card branch cut locally from the (stale) HEAD: it tracks nothing.
    sh(r.work, 'git checkout -q -b feat/card-1');
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(verdict(res).detail).toMatch(/tracks no remote branch and sits 1 commit behind origin\/main/);
  });

  it('does not judge the base of a branch with no upstream that has its own commits', async () => {
    const r = remoteSetup();
    r.pushFromOther('b');
    sh(r.work, 'git checkout -q -b feat/card-2');
    r.commitHere('mine');
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await recorded(cid)).detail).toMatch(/of its own/);
  });

  it('runs in the background: a fetch never holds the request (review)', async () => {
    const r = remoteSetup();
    const cid = await card(r.work);
    const v = await agent().post(`/items/${cid}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status, JSON.stringify(v.body)).toBe(202);
  });

  it('only warns when the remote cannot be reached: offline work is not stranded', async () => {
    const r = remoteSetup();
    sh(r.work, 'git remote set-url origin /nonexistent/agenfk-remote.git');
    const cid = await card(r.work);
    const res = await validate(cid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await recorded(cid)).toMatchObject({ outcome: 'unavailable', blocking: false });
  });

  it('waits for a person first: no fetch runs while an approval is missing, and it is reported deferred', async () => {
    const r = remoteSetup();
    r.pushFromOther('b');
    const cid = await card(r.work, { role: 'backlog', checks: [{ id: 'human-approval' }] });
    const res = await validate(cid);
    expect(res.status).toBe(422);
    expect((res.body.checks as any[]).filter(c => c.blocking).map(c => c.id)).toEqual(['human-approval']);
    expect(verdict(res)).toMatchObject({ outcome: 'deferred', blocking: false });
    // Nothing was fetched: the card's clone still does not know origin moved.
    expect(sh(r.work, 'git rev-list --count HEAD..origin/main')).toBe('0');
  });
});
