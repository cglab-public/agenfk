import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-repo-scope-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

const sampleDef = (name: string) => ({
  name,
  description: '',
  steps: [
    { id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true },
    { id: 's1', name: 'work', label: 'Work', order: 1 },
    { id: 's2', name: 'done', label: 'Done', order: 2, isAnchor: true },
  ],
});

async function seedFlow(app: any, cookie: string, name: string): Promise<string> {
  const r = await supertest(app).post('/v1/admin/flows').set('Cookie', cookie)
    .send({ definition: sampleDef(name) });
  return r.body.id;
}

async function assign(app: any, cookie: string, scope: string, targetId: string | null, flowId: string | null) {
  const body: any = { scope, flowId };
  if (targetId !== null) body.targetId = targetId;
  return supertest(app).put('/v1/admin/flow-assignments').set('Cookie', cookie).send(body);
}

async function markAvailable(app: any, cookie: string, flowId: string) {
  // Org-availability is required before a flow can be selected by a client.
  return supertest(app).put(`/v1/admin/flows/${flowId}/availability`).set('Cookie', cookie).send({ available: true });
}

async function seedEvent(db: any, orgId: string, installationId: string, remoteUrl: string, projectId = 'p-x') {
  await db.run(
    `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, remote_url, payload)
     VALUES (?, ?, ?, 'u', datetime('now'), datetime('now'), 'item.created', ?, ?, '{}')`,
    [`evt-${Math.random().toString(36).slice(2)}`, orgId, installationId, projectId, remoteUrl],
  );
}

// Canonical form produced by sanitizeRemoteUrl for github.com/acme/web.
const CANON = 'git@github.com:acme/web.git';

describe('repo-keyed flow axis', () => {
  let app: any;
  let ctx: any;
  let cookie: string;
  let tokenInstall1: string;
  let tokenInstall2: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'test-session-secret', defaultOrgId: 'org-a',
    });
    app = out.app; ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    cookie = await loginAs(app, 'admin@x', 'longenough1');
    for (const id of ['install-1', 'install-2']) {
      await ctx.db.run(
        "INSERT INTO installations (id, org_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))",
        [id, 'org-a'],
      );
    }
    tokenInstall1 = await issueApiKey(ctx.db, 'org-a', 'i1', { installationId: 'install-1' });
    tokenInstall2 = await issueApiKey(ctx.db, 'org-a', 'i2', { installationId: 'install-2' });
  });

  afterEach(async () => { await ctx.db.close(); cleanup(); });

  describe('resolution (GET /v1/flows/active?repo=)', () => {
    it('matches a repo-scoped assignment when ?repo is provided', async () => {
      const orgFlow = await seedFlow(app, cookie, 'Org');
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await assign(app, cookie, 'org', null, orgFlow);
      await assign(app, cookie, 'repo', CANON, repoFlow);

      const r = await supertest(app).get(`/v1/flows/active?repo=${encodeURIComponent(CANON)}`)
        .set('Authorization', `Bearer ${tokenInstall1}`);
      expect(r.body.flow.id).toBe(repoFlow);
      expect(r.body.scope).toBe('repo');
      expect(r.body.targetId).toBe(CANON);
    });

    it('normalizes the ?repo param so ssh/https/case/.git variants collapse', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await assign(app, cookie, 'repo', 'https://GitHub.com/ACME/web.git', repoFlow); // admin write is sanitized too
      const variants = [
        'https://github.com/acme/web',
        'git@github.com:acme/web.git',
        'https://GITHUB.com/Acme/Web.git/',
      ];
      for (const v of variants) {
        const r = await supertest(app).get(`/v1/flows/active?repo=${encodeURIComponent(v)}`)
          .set('Authorization', `Bearer ${tokenInstall1}`);
        expect(r.body.flow?.id, `variant ${v}`).toBe(repoFlow);
        expect(r.body.scope).toBe('repo');
      }
    });

    it('repo override beats project-legacy and org', async () => {
      const orgFlow = await seedFlow(app, cookie, 'Org');
      const projFlow = await seedFlow(app, cookie, 'Proj');
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await assign(app, cookie, 'org', null, orgFlow);
      await assign(app, cookie, 'project', 'p-legacy', projFlow);
      await assign(app, cookie, 'repo', CANON, repoFlow);

      const r = await supertest(app).get(`/v1/flows/active?projectId=p-legacy&repo=${encodeURIComponent(CANON)}`)
        .set('Authorization', `Bearer ${tokenInstall1}`);
      expect(r.body.flow.id).toBe(repoFlow);
      expect(r.body.scope).toBe('repo');
    });

    it('installation override beats repo', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      const instFlow = await seedFlow(app, cookie, 'Inst');
      await assign(app, cookie, 'repo', CANON, repoFlow);
      await assign(app, cookie, 'installation', 'install-1', instFlow);

      const r = await supertest(app).get(`/v1/flows/active?repo=${encodeURIComponent(CANON)}`)
        .set('Authorization', `Bearer ${tokenInstall1}`);
      expect(r.body.flow.id).toBe(instFlow);
      expect(r.body.scope).toBe('installation');
    });

    it('two installations of the same repo both resolve the repo flow', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await assign(app, cookie, 'repo', CANON, repoFlow);
      for (const tok of [tokenInstall1, tokenInstall2]) {
        const r = await supertest(app).get(`/v1/flows/active?repo=${encodeURIComponent(CANON)}`)
          .set('Authorization', `Bearer ${tok}`);
        expect(r.body.flow.id).toBe(repoFlow);
      }
    });
  });

  describe('selection (PUT /v1/flows/selection with { repo })', () => {
    it('writes a repo-scoped assignment and is resolvable', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await markAvailable(app, cookie, repoFlow);
      await seedEvent(ctx.db, 'org-a', 'install-1', CANON);

      const sel = await supertest(app).put('/v1/flows/selection')
        .set('Authorization', `Bearer ${tokenInstall1}`)
        .send({ repo: 'https://github.com/acme/web', flowId: repoFlow });
      expect(sel.status).toBe(200);
      expect(sel.body.scope).toBe('repo');
      expect(sel.body.repo).toBe(CANON);

      const active = await supertest(app).get(`/v1/flows/active?repo=${encodeURIComponent(CANON)}`)
        .set('Authorization', `Bearer ${tokenInstall1}`);
      expect(active.body.flow.id).toBe(repoFlow);
      expect(active.body.scope).toBe('repo');
    });

    it('allows selection for an unseen repo (trust on first use)', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await markAvailable(app, cookie, repoFlow);
      const sel = await supertest(app).put('/v1/flows/selection')
        .set('Authorization', `Bearer ${tokenInstall1}`)
        .send({ repo: CANON, flowId: repoFlow });
      expect(sel.status).toBe(200);
    });

    it('rejects selection for a repo seen only from another installation', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await markAvailable(app, cookie, repoFlow);
      await seedEvent(ctx.db, 'org-a', 'install-2', CANON); // only install-2 has touched it
      const sel = await supertest(app).put('/v1/flows/selection')
        .set('Authorization', `Bearer ${tokenInstall1}`)
        .send({ repo: CANON, flowId: repoFlow });
      expect(sel.status).toBe(403);
    });

    it('clears a repo selection when flowId is null', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      await markAvailable(app, cookie, repoFlow);
      await seedEvent(ctx.db, 'org-a', 'install-1', CANON);
      await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${tokenInstall1}`)
        .send({ repo: CANON, flowId: repoFlow });
      const clear = await supertest(app).put('/v1/flows/selection').set('Authorization', `Bearer ${tokenInstall1}`)
        .send({ repo: CANON, flowId: null });
      expect(clear.status).toBe(200);
      const active = await supertest(app).get(`/v1/flows/active?repo=${encodeURIComponent(CANON)}`)
        .set('Authorization', `Bearer ${tokenInstall1}`);
      expect(active.body.flow).toBeNull();
    });
  });

  describe('admin assignment + discovery', () => {
    it('admin can create a repo-scoped assignment (targetId sanitized) and GET returns it', async () => {
      const repoFlow = await seedFlow(app, cookie, 'Repo');
      const put = await assign(app, cookie, 'repo', 'https://github.com/acme/web.git', repoFlow);
      expect(put.status).toBe(200);

      const list = await supertest(app).get('/v1/admin/flow-assignments').set('Cookie', cookie);
      const repoRow = list.body.find((a: any) => a.scope === 'repo');
      expect(repoRow).toBeTruthy();
      expect(repoRow.targetId).toBe(CANON);
      expect(repoRow.remoteUrl).toBe(CANON);
    });

    it('GET /v1/admin/projects returns distinct repos seen in events', async () => {
      await seedEvent(ctx.db, 'org-a', 'install-1', CANON, 'p-1');
      await seedEvent(ctx.db, 'org-a', 'install-2', CANON, 'p-2'); // same repo, different local projectId
      await seedEvent(ctx.db, 'org-a', 'install-1', 'git@github.com:acme/api.git', 'p-3');

      const r = await supertest(app).get('/v1/admin/projects').set('Cookie', cookie);
      expect(r.status).toBe(200);
      const repos = r.body.map((x: any) => x.remoteUrl).sort();
      expect(repos).toEqual(['git@github.com:acme/api.git', CANON]);
    });
  });
});
