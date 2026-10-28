/**
 * PO-1 (c6af1eb0): the server answers a project's effective policy - the org
 * policy with that project's override applied - and judges a tool call by the
 * active card's project. A project is found by its repository (deps.projectRepoOf,
 * the git origin in the server), or by project:<id> when it has no remote.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy } from '@agenfk/core';
import { registerAirlockRoutes } from '../airlock/routes';

let storage: SQLiteStorageProvider;
let tmp: string;
let app: express.Express;
let work: { itemId: string; projectId: string } | null;
// what the coverage middleware sets on a request the launcher's relay marked
let marked: { session: string; project: string | null } | null;
let repoLookups: string[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-project-policy-'));
  storage = new SQLiteStorageProvider();
  await storage.init({ path: path.join(tmp, 'db.sqlite') });
  await storage.putAirlockPolicy({
    scope: 'local', revision: 1,
    policy: normalizeAirlockPolicy({
      ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce', hosts: { allow: ['api.github.com'], deny: [] },
      projects: {
        'github.com/acme/api': { hosts: { allow: ['pypi.org'], deny: ['tracker.example'] }, rules: { cloudMutation: 'deny' } },
        'project:local-1': { hosts: { allow: ['localonly.example'] } },
      },
    }),
    updatedAt: new Date().toISOString(), updatedBy: 'test', authority: 'local',
  }, 0);
  work = null;
  marked = null;
  repoLookups = [];
  app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { if (marked) { req.airlockSession = marked.session; req.airlockProject = marked.project; } next(); });
  registerAirlockRoutes(app, {
    storage: () => storage,
    hubJoined: () => false,
    recordHubEvent: vi.fn(),
    emit: vi.fn(),
    activeWork: () => work,
    stateFile: () => path.join(tmp, 'airlock-state.json'),
    projectRepoOf: async (id: string) => {
      repoLookups.push(id);
      if (id === 'p-slow') throw new Error('the lookup of its git remote timed out');
      return id === 'p-api' ? 'git@github.com:Acme/api.git' : null;
    },
  });
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const evaluate = (command: string) => request(app).post('/airlock/evaluate').send({ client: 'pi', model: 'cloudflare/glm', toolName: 'bash', args: { command } });

describe('GET /airlock/policy?projectId=', () => {
  it('answers the project\'s effective policy, its repository named', async () => {
    const res = await request(app).get('/airlock/policy?projectId=p-api');
    expect(res.status).toBe(200);
    expect(res.body.effective.hosts.allow).toEqual(['api.github.com', 'pypi.org']);
    expect(res.body.effective.hosts.deny).toEqual(['tracker.example']);
    expect(res.body.effective.rules.cloudMutation).toBe('deny');
    expect(res.body.effective.projects).toBeUndefined();
    expect(res.body.project).toEqual({ id: 'p-api', repo: 'github.com/acme/api' });
  });

  it('a project with no remote takes its project:<id> override; one with none, the org policy', async () => {
    expect((await request(app).get('/airlock/policy?projectId=local-1')).body.effective.hosts.allow).toEqual(['api.github.com', 'localonly.example']);
    expect((await request(app).get('/airlock/policy?projectId=other')).body.effective.hosts.allow).toEqual(['api.github.com']);
  });

  it('without a project it answers the org policy, overrides and all (what the editors show)', async () => {
    const res = await request(app).get('/airlock/policy');
    expect(Object.keys(res.body.effective.projects)).toEqual(['github.com/acme/api', 'project:local-1']);
  });
});

describe('the server says what its launches can rely on (BUG 1a7dd9d2)', () => {
  it('both forms of GET /airlock/policy name sandboxed-commands: this server runs a covered card\'s commands in the sandbox', async () => {
    for (const p of ['/airlock/policy', '/airlock/policy?projectId=p-api']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(200);
      expect(res.body.capabilities, p).toEqual(expect.arrayContaining(['sandboxed-commands']));
    }
  });
});

describe('POST /airlock/evaluate: by the active card\'s project', () => {
  it('a host the project denies is denied there, and allowed for another project', async () => {
    work = { itemId: 'c1', projectId: 'p-api' };
    expect((await evaluate('curl https://tracker.example/')).body.verdict).toMatchObject({ decision: 'deny', rule: 'denied-host' });
    work = { itemId: 'c2', projectId: 'other' };
    expect((await evaluate('curl https://tracker.example/')).body.verdict.decision).not.toBe('deny');
  });

  it('a rule the project tightens applies to its cards only', async () => {
    work = { itemId: 'c1', projectId: 'p-api' };
    expect((await evaluate('aws s3 rm s3://b/k')).body.verdict).toMatchObject({ decision: 'deny', rule: 'cloud-mutation' });
    work = { itemId: 'c2', projectId: 'other' };
    expect((await evaluate('aws s3 rm s3://b/k')).body.verdict).toMatchObject({ decision: 'needs-human-approval' });
  });
});

describe('PO-1 review (Codex gpt-6.1-sol 01a182d1)', () => {
  it('a sandboxed call is judged under the project its launch was signed for, whatever note the session has', async () => {
    marked = { session: 'n1', project: 'p-api' };
    expect((await evaluate('curl https://tracker.example/')).body.verdict).toMatchObject({ decision: 'deny', rule: 'denied-host' });
    // the agent cannot pick a looser project through the active-work note
    work = { itemId: 'c2', projectId: 'other' };
    expect((await evaluate('aws s3 rm s3://b/k')).body.verdict).toMatchObject({ decision: 'deny', rule: 'cloud-mutation' });
    // a launch outside any project: the org policy, not a note's project
    marked = { session: 'n2', project: null };
    work = { itemId: 'c1', projectId: 'p-api' };
    expect((await evaluate('aws s3 rm s3://b/k')).body.verdict).toMatchObject({ decision: 'needs-human-approval' });
  });

  it('a repository that cannot be looked up fails closed (503), on GET and on evaluate', async () => {
    const get = await request(app).get('/airlock/policy?projectId=p-slow');
    expect(get.status).toBe(503);
    expect(get.body.error).toBe('AIRLOCK_PROJECT_UNKNOWN');
    work = { itemId: 'c1', projectId: 'p-slow' };
    expect((await evaluate('echo hi')).status).toBe(503);
  });

  it('with no repository overrides a failed lookup costs nothing: evaluate makes none, GET pins but does not fail', async () => {
    const current = (await storage.getAirlockPolicy('local'))!;
    await storage.putAirlockPolicy({ ...current, revision: 2, policy: normalizeAirlockPolicy({ ...current.policy, projects: { 'project:local-1': { hosts: { allow: ['x.example'] } } } }) }, 1);
    work = { itemId: 'c1', projectId: 'p-slow' };
    expect((await evaluate('echo hi')).status).toBe(200);
    expect(repoLookups).toEqual([]);
    // the launcher's fetch pins the repository before its sandbox starts, overrides or not (review 5)
    const res = await request(app).get('/airlock/policy?projectId=p-slow');
    expect(res.status).toBe(200);
    expect(res.body.project).toEqual({ id: 'p-slow', repo: null });
    expect(repoLookups).toEqual(['p-slow']);
    await request(app).get('/airlock/policy?projectId=p-api');
    expect(repoLookups).toEqual(['p-slow', 'p-api']);
  });
});

describe('PO-1 review 2: approvals belong to the project the call was judged under', () => {
  it('two launches in different projects, with no notes, never share an approval', async () => {
    const current = (await storage.getAirlockPolicy('local'))!;
    await storage.putAirlockPolicy({ ...current, revision: 2, policy: normalizeAirlockPolicy({ ...current.policy, projects: { 'project:local-1': { hosts: { allow: ['x.example'] } } } }) }, 1);
    marked = { session: 'n1', project: 'proj-a' };
    const a = (await evaluate('aws s3 rm s3://b/k')).body.verdict;
    marked = { session: 'n2', project: 'proj-b' };
    const b = (await evaluate('aws s3 rm s3://b/k')).body.verdict;
    expect(a.decision).toBe('needs-human-approval');
    expect(a.approvalKey).not.toBe(b.approvalKey);
    expect((await storage.getAirlockApproval(a.approvalKey))?.projectId).toBe('proj-a');
  });
});
