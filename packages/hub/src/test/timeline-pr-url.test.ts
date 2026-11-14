// GET /v1/timeline gives each PR event a link to the pull request when the hub
// can derive one (github.com only, the same rule as the PR drill-down), so the
// user page can link it without guessing hosts (story ce9b0e8e).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);
const ev = (id: string, type: string, over: any = {}) => ({
  eventId: id, installationId: 'inst-1', orgId: 'org', occurredAt: over.at ?? '2026-05-01T10:00:00.000Z',
  actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
  type, projectId: 'p1', itemId: 'i1', remoteUrl: over.remoteUrl, payload: over.payload ?? {},
});

describe('GET /v1/timeline — pr_url', () => {
  let app: any;
  let db: HubDb;
  let cookie: string;

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org', db });
    app = out.app;
    await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
    const token = await issueApiKey(db, 'org', 't');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [
      ev('gh', 'pr.opened', { remoteUrl: 'git@github.com:acme/api.git', payload: { prNumber: 7, repo: 'acme/api' } }),
      ev('gl', 'pr.opened', { at: '2026-05-01T09:00:00.000Z', remoteUrl: 'git@gitlab.com:acme/api.git', payload: { prNumber: 8, repo: 'acme/api' } }),
      ev('other', 'item.created', { at: '2026-05-01T08:00:00.000Z', remoteUrl: 'git@github.com:acme/api.git' }),
    ] });
  });
  afterEach(async () => { await drainApp(app); await db.close(); });

  it('links a GitHub PR, and nothing else', async () => {
    const r = await supertest(app).get('/v1/timeline').set('Cookie', cookie);
    const by = Object.fromEntries(r.body.events.map((e: any) => [e.event_id, e]));
    expect(by.gh.pr_url).toBe('https://github.com/acme/api/pull/7');
    // A non-GitHub host is never guessed at.
    expect(by.gl.pr_url).toBeNull();
    expect(by.other.pr_url).toBeNull();
  });
});
