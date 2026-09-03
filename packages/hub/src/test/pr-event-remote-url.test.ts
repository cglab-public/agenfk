/**
 * BUG 418ee7bd — PR events (`pr.opened` / `pr.updated`) frequently arrive with
 * `remoteUrl: null` because the emitter's `git remote get-url origin` shell-out
 * failed, stranding the PR's authoritative `owner/repo` (declared by the agent)
 * inside the JSON payload where the `remote_url` filter dimension can't see it.
 *
 * Fix: at hub ingestion, PREFER the resolved `remoteUrl`; when it's absent,
 * derive it from `payload.repo` (owner/repo → canonical `git@github.com:…`,
 * collapsed via sanitizeRemoteUrl) so PR events land on the SAME project-filter
 * chip as the repo's other events. A boot-time backfill repairs historical rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { remoteUrlFromRepo, sanitizeRemoteUrl } from '../util/remoteUrl';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-pr-remote-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const prEvent = (overrides: any = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org-a',
  occurredAt: '2026-07-14T10:00:00Z',
  actor: { osUser: 'tester' },
  type: 'pr.opened',
  payload: { prNumber: 434, repo: 'carsales-PRIVATE/dataservice', sizing: { epic: 0, story: 1, task: 1, bug: 0 } },
  ...overrides,
});

describe('remoteUrlFromRepo (unit)', () => {
  it('derives a canonical github remote from a bare owner/repo slug', () => {
    expect(remoteUrlFromRepo('carsales-PRIVATE/dataservice'))
      .toBe('git@github.com:carsales-PRIVATE/dataservice.git');
  });

  it('strips a trailing .git from the repo name', () => {
    expect(remoteUrlFromRepo('owner/repo.git')).toBe('git@github.com:owner/repo.git');
  });

  it('trims surrounding whitespace', () => {
    expect(remoteUrlFromRepo('  owner/repo  ')).toBe('git@github.com:owner/repo.git');
  });

  it('returns null for a host-qualified path (not a bare slug)', () => {
    expect(remoteUrlFromRepo('github.com/owner/repo')).toBeNull();
  });

  it('returns null for a full URL', () => {
    expect(remoteUrlFromRepo('https://github.com/owner/repo')).toBeNull();
  });

  it('returns null for junk with no slash', () => {
    expect(remoteUrlFromRepo('not-a-repo')).toBeNull();
  });

  it('composes with sanitizeRemoteUrl onto the same chip as a real git remote', () => {
    const derived = sanitizeRemoteUrl(remoteUrlFromRepo('carsales-PRIVATE/dataservice')!);
    const fromGit = sanitizeRemoteUrl('git@github.com:carsales-private/dataservice.git');
    expect(derived).toBe(fromGit);
    expect(derived).toBe('git@github.com:carsales-private/dataservice.git');
  });
});

describe('sanitizeRemoteUrl (unit)', () => {
  // The chip-collapse function: canonical ssh form wins, noise is stripped
  // first, and anything unparseable is returned cleaned (never a guess).
  it('canonicalises an https remote onto the canonical ssh form', () => {
    expect(sanitizeRemoteUrl('https://github.com/acme/api'))
      .toBe('git@github.com:acme/api.git');
  });

  it('strips noise (whitespace/control chars) before parsing and canonicalising', () => {
    expect(sanitizeRemoteUrl('  git@github.com:acme/api \t .git  '))
      .toBe('git@github.com:acme/api.git');
  });

  it('returns the cleaned input for anything that does not parse (never throws, never guesses)', () => {
    // no host/owner/repo structure → no canonical form exists; the chip shows
    // the stripped + lowercased input instead.
    expect(sanitizeRemoteUrl('not a remote')).toBe('notaremote');
  });
});

describe('Hub: PR events populate the remote_url filter dimension', { hookTimeout: 30_000 }, () => {
  let app: any;
  let ctx: any;
  let cookieAdmin: string;
  let token: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookieAdmin = login.headers['set-cookie']?.[0] ?? '';
    token = await issueApiKey(ctx.db, 'org-a', 'inst-1');
  });
  afterEach(async () => { await ctx.db.close(); cleanup(); });

  it('derives remote_url from payload.repo when the event has no remoteUrl', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [prEvent()] });
    const row = await ctx.db.get<{ remote_url: string }>('SELECT remote_url FROM events LIMIT 1');
    expect(row.remote_url).toBe('git@github.com:carsales-private/dataservice.git');
  });

  it('prefers the emitter-resolved remoteUrl over the payload repo', async () => {
    // remoteUrl points at one repo, payload.repo at another: the resolved
    // remote wins (it may be a non-github / GHE host we can't infer from repo).
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [prEvent({
        remoteUrl: 'git@ghe.internal:team/service.git',
        payload: { prNumber: 1, repo: 'carsales-PRIVATE/dataservice' },
      })] });
    const row = await ctx.db.get<{ remote_url: string }>('SELECT remote_url FROM events LIMIT 1');
    expect(row.remote_url).toBe('git@ghe.internal:team/service.git');
  });

  it('leaves remote_url null when payload.repo is not a bare owner/repo slug', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [prEvent({ payload: { prNumber: 2, repo: 'not-a-repo' } })] });
    const row = await ctx.db.get<{ remote_url: string | null }>('SELECT remote_url FROM events LIMIT 1');
    expect(row.remote_url).toBeNull();
  });

  it('surfaces the derived repo as a project chip and matches the ?projects filter', async () => {
    await supertest(app)
      .post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [prEvent()] });

    const projects = await supertest(app).get('/v1/projects').set('Cookie', cookieAdmin);
    expect(projects.status).toBe(200);
    expect(projects.body.projects).toEqual(['git@github.com:carsales-private/dataservice.git']);

    // The UI filters by the chip value returned from /v1/projects (the
    // canonical remote form), and https/ssh variants canonicalise to it too.
    const timeline = await supertest(app)
      .get('/v1/timeline?projects=' + encodeURIComponent('https://github.com/carsales-private/dataservice'))
      .set('Cookie', cookieAdmin);
    expect(timeline.status).toBe(200);
    expect(timeline.body.events.length).toBe(1);
  });

  it('boot-time backfill repairs historical PR rows with null remote_url', async () => {
    // Simulate a pre-fix row: PR event stored with remote_url NULL, repo only
    // inside the payload blob (payload column holds the whole event, so repo is
    // at $.payload.repo).
    const legacyPayload = JSON.stringify({
      eventId: 'legacy-pr', type: 'pr.opened',
      payload: { prNumber: 99, repo: 'carsales-PRIVATE/dataservice' },
    });
    await ctx.db.run(
      `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, remote_url, payload)
       VALUES ('legacy-pr', 'org-a', 'inst-1', 'tester', ?, ?, 'pr.opened', NULL, ?)`,
      ['2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', legacyPayload],
    );
    await ctx.db.close();

    const out = await createHubApp({
      dbPath: TEST_DB,
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
    });
    ctx = out.ctx;
    const row = await ctx.db.get<{ remote_url: string }>(
      "SELECT remote_url FROM events WHERE event_id = 'legacy-pr'",
    );
    expect(row.remote_url).toBe('git@github.com:carsales-private/dataservice.git');
  });
});
