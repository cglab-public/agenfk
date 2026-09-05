import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { decryptSecret } from '../crypto';

/**
 * Per-org flow registry repo (CGLAB-138).
 *
 * An admin of a hub-connected company points the org's flow registry at an
 * EXISTING private repo. On save the hub must (a) probe write access with the
 * org's stored GitHub token and FAIL THE SAVE if the probe fails — nothing
 * persisted, no half-applied setting; (b) on success, copy the community flows
 * present at switch time into the new repo ONCE; (c) serve browse/install from
 * the org repo thereafter, authenticated so a PRIVATE target works fleet-wide;
 * (d) let the admin move back to the public repo with no reverse copy.
 */

const SECRET = 'a'.repeat(64);
const PUBLIC_REPO = 'cglab-public/agenfk-flows';
const ORG_REPO = 'acme-corp/agenfk-flows';

const loginAs = async (app: any, email: string, password: string) => {
  const r = await supertest(app).post('/auth/login').send({ email, password });
  return r.headers['set-cookie']?.[0] ?? '';
};

/** Two community flows, as the public registry serves them. */
const COMMUNITY_FLOWS = [
  { name: 'TDD Flow', author: 'cglab', version: '1.0.0', steps: [
    { name: 'DISCOVERY', label: 'Discovery', order: 1, exitCriteria: 'x' },
    { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ] },
  { name: 'Lean Flow', author: 'cglab', version: '2.1.0', steps: [
    { name: 'BUILD', label: 'Build', order: 1 },
  ] },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * A GitHub API fake. Records every call so tests can assert exactly what the
 * hub sent — including that the token rides along on READS, which is the whole
 * reason Option B (hub-stored token) was chosen over a laptop `gh` token:
 * anonymous reads 404 on a private repo.
 */
function githubFake(opts: {
  writeOk?: boolean;
  privateRead?: boolean;
  files?: Record<string, string>;
} = {}) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: any }> = [];
  const written: Record<string, string> = { ...(opts.files ?? {}) };

  const fn = vi.fn(async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = init?.headers?.['Authorization'] ?? init?.headers?.['authorization'];
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, auth, body });

    const isPublic = url.includes(PUBLIC_REPO);
    const isOrg = url.includes(ORG_REPO);

    // A private org repo is invisible without a valid token.
    if (isOrg && opts.privateRead && !auth) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }

    // Write-access probe: the repos/{owner}/{repo} metadata call.
    if (method === 'GET' && /\/repos\/[^/]+\/[^/?]+$/.test(url.split('?')[0])) {
      if (isOrg && opts.writeOk === false) {
        return { ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) };
      }
      return { ok: true, status: 200, json: async () => ({ full_name: isOrg ? ORG_REPO : PUBLIC_REPO, private: isOrg }) };
    }

    // Directory listing. The org repo starts from `files` (what a partial copy
    // left behind) and grows as PUTs land, so a re-run sees real state.
    if (method === 'GET' && url.includes('/contents/flows?')) {
      const names = isOrg ? Object.keys(written) : COMMUNITY_FLOWS.map((f) => `${slug(f.name)}.json`);
      return {
        ok: true, status: 200,
        json: async () => names.map((name) => ({
          name, type: 'file',
          download_url: `${isOrg ? 'https://org.test' : 'https://pub.test'}/${name}`,
        })),
      };
    }

    // A single flow file read.
    if (method === 'GET' && (url.startsWith('https://pub.test/') || url.startsWith('https://org.test/'))) {
      const name = url.split('/').pop()!;
      // Org reads serve whatever the org repo actually holds.
      if (isOrg) {
        if (written[name]) return { ok: true, status: 200, json: async () => JSON.parse(written[name]) };
        return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      }
      const flow = COMMUNITY_FLOWS.find((f) => `${slug(f.name)}.json` === name);
      if (flow) return { ok: true, status: 200, json: async () => flow };
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }

    // Contents API fetch (needed before a PUT to avoid clobbering).
    if (method === 'GET' && url.includes('/contents/flows/')) {
      const name = decodeURIComponent(url.split('/contents/flows/')[1].split('?')[0]);
      if (written[name]) {
        return {
          ok: true, status: 200,
          json: async () => ({ content: Buffer.from(written[name]).toString('base64'), sha: 'sha-' + name }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }

    // Write.
    if (method === 'PUT' && url.includes('/contents/flows/')) {
      if (opts.writeOk === false) {
        return { ok: false, status: 403, json: async () => ({ message: 'Resource not accessible by integration' }) };
      }
      const name = decodeURIComponent(url.split('/contents/flows/')[1].split('?')[0]);
      written[name] = Buffer.from(body.content, 'base64').toString('utf8');
      return { ok: true, status: 201, json: async () => ({ content: { name, sha: 'new-sha' } }) };
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return { fn, calls, written };
}

describe('hub admin: per-org flow registry repo (CGLAB-138)', () => {
  let app: any;
  let ctx: any;
  let db: any;
  let cookieAdmin: string;
  let cookieView: string;

  beforeEach(async () => {
    // In-memory sqlite injected through createHubApp's `db` escape hatch: no
    // tmpdir file, no WAL sidecars, nothing shared with another test file.
    // These tests stub global fetch and mutate no process.env, so they are
    // safe to run file-concurrently — unlike the file-backed hub tests.
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({
      dbPath: ':memory:',
      secretKey: SECRET,
      sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a',
      db,
    });
    app = out.app;
    ctx = out.ctx;
    await createPasswordUser(ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(app, 'admin@x', 'longenough1');
    cookieView = await loginAs(app, 'view@x', 'longenough1');
  });

  afterEach(async () => {
    await db.close();
    vi.unstubAllGlobals();
  });

  // ── GET /v1/admin/registry-config ─────────────────────────────────────────
  it('GET /v1/admin/registry-config defaults to the public repo with no token', async () => {
    const r = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.repo).toBe(PUBLIC_REPO);
    expect(r.body.isPublic).toBe(true);
    expect(r.body.hasToken).toBe(false);
  });

  it('GET /v1/admin/registry-config NEVER returns the token, only that one exists', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin)
      .send({ repo: ORG_REPO, token: 'ghp_supersecret_token_123' });

    const r = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin);
    expect(JSON.stringify(r.body)).not.toContain('ghp_supersecret_token_123');
    expect(r.body.hasToken).toBe(true);
    // The shape must not leak the ciphertext either.
    expect(JSON.stringify(r.body)).not.toContain('v1:');
  });

  it('GET /v1/admin/registry-config rejects non-admin', async () => {
    const r = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  // ── PUT /v1/admin/registry-config — validation ────────────────────────────
  it('PUT rejects a repo that is not owner/repo', async () => {
    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: 'not-a-slug' });
    expect(r.status).toBe(400);
  });

  it('PUT rejects a repo slug that could break out of a git/URL argument', async () => {
    // Mirrors the GH_NAME_RE guard on the local publish route: a leading dash
    // would be read as a flag by an argv-form git call.
    for (const bad of ['-evil/repo', 'owner/-evil', 'own er/repo', 'owner/repo;rm -rf /', 'a/b/c']) {
      const r = await supertest(app).put('/v1/admin/registry-config')
        .set('Cookie', cookieAdmin).send({ repo: bad, token: 'ghp_x' });
      expect(r.status, bad).toBe(400);
    }
  });

  it('PUT rejects a malformed branch with 400 before touching GitHub', async () => {
    // A bad ref is worse than a bad repo here: listRegistryFiles reads GitHub's
    // 404 as "empty registry", so a stored-but-unusable branch presents the
    // admin with a registry of zero flows and no error anywhere. Reject it at
    // the boundary instead, and do it before any network call.
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    for (const bad of ['ma in', 'main?ref=other', '../../etc/passwd', '-main', 'main/', 'main\n']) {
      const r = await supertest(app).put('/v1/admin/registry-config')
        .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x', branch: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error, JSON.stringify(bad)).toMatch(/branch/i);
    }
    expect(gh.calls).toHaveLength(0);
    const after = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin);
    expect(after.body.branch).toBe('main');
  });

  it('PUT accepts a namespaced branch and stores it verbatim', async () => {
    // release/2.0 is an ordinary branch name; a guard that rejected '/' would
    // lock admins out of the flow they most likely want.
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x', branch: 'release/2.0' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin);
    expect(after.body.branch).toBe('release/2.0');
  });

  it('PUT rejects a non-admin', async () => {
    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieView).send({ repo: ORG_REPO, token: 'ghp_x' });
    expect(r.status).toBe(403);
  });

  // ── PUT — fail the save ───────────────────────────────────────────────────
  it('PUT fails the save when the write probe fails, and persists NOTHING', async () => {
    const gh = githubFake({ writeOk: false, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);

    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });

    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/write|access|probe/i);

    // The decisive assertion: the setting did NOT land.
    const after = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin);
    expect(after.body.repo).toBe(PUBLIC_REPO);
    expect(after.body.hasToken).toBe(false);
    // And no flow was written into the rejected repo.
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('PUT fails the save when no token is available for a private target', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/token/i);
  });

  // ── PUT — the one-time copy ───────────────────────────────────────────────
  it('PUT copies every community flow into the org repo exactly once', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);

    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });

    expect(r.status).toBe(200);
    expect(r.body.repo).toBe(ORG_REPO);
    expect(r.body.copied).toBe(COMMUNITY_FLOWS.length);
    // `truncated` is present and false on the ordinary path, not merely absent
    // on the truncated one. The UI renders a partial-copy warning from this
    // field, so a response that omitted it would hide an incomplete registry.
    expect(r.body.truncated).toBe(false);

    const puts = gh.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(COMMUNITY_FLOWS.length);
    // Each flow lands under a deterministic slug in flows/ (a ?ref= query may follow).
    for (const p of puts) expect(p.url).toMatch(/\/contents\/flows\/[a-z0-9-]+\.json(\?|$)/);
    // The copied content is a valid flow document, not a raw echo.
    const first = JSON.parse(Buffer.from(puts[0].body.content, 'base64').toString('utf8'));
    expect(typeof first.name).toBe('string');
    expect(Array.isArray(first.steps)).toBe(true);
  });

  it('PUT stores the token encrypted at rest, decryptable with the hub key', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_supersecret_token_123' });

    const row = await ctx.db.get<{ registry_repo: string; registry_token_enc: string | null }>(
      'SELECT registry_repo, registry_token_enc FROM org_settings WHERE org_id = ?', ['org-a']);
    expect(row).toBeTruthy();
    expect(row!.registry_repo).toBe(ORG_REPO);
    expect(row!.registry_token_enc).toBeTruthy();
    expect(row!.registry_token_enc!).not.toContain('ghp_supersecret_token_123');
    expect(row!.registry_token_enc!.startsWith('v1:')).toBe(true);
    expect(decryptSecret(row!.registry_token_enc!, SECRET)).toBe('ghp_supersecret_token_123');
  });

  it('PUT does NOT re-copy when the repo is unchanged (copy is one-time)', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });
    const firstPuts = gh.calls.filter((c) => c.method === 'PUT').length;
    expect(firstPuts).toBeGreaterThan(0);

    gh.calls.length = 0;
    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO });
    expect(r.status).toBe(200);
    expect(r.body.copied).toBe(0);
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('POST /v1/admin/registry-config/sync re-runs the copy after a partial run', async () => {
    // The point of sync is recovering a PARTIAL copy. Seed a half-populated
    // org repo — one flow already present, the other missing — then check sync
    // writes only what is absent. A fully-copied repo must be a no-op, which is
    // what makes re-running safe.
    const gh = githubFake({
      writeOk: true, privateRead: true,
      files: { 'tdd-flow.json': '{ "name": "TDD Flow", "steps": [] }' },
    });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });
    // Reset to the half-populated state the switch left behind: the copy just
    // wrote lean-flow.json, but for this test we want the run to have STOPPED
    // before it, so remove it again. Without this the sync correctly finds
    // nothing missing and the partial-recovery path is never exercised.
    delete gh.written['lean-flow.json'];
    gh.calls.length = 0;

    const r = await supertest(app).post('/v1/admin/registry-config/sync')
      .set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.copied).toBe(1);
    expect(r.body.skipped).toBe(1);
    // The sync response carries the same shape as the save response, including
    // `truncated` — the two routes build it separately, so both need pinning.
    expect(r.body.truncated).toBe(false);
    const puts = gh.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain('lean-flow.json');
  });

  it('sync is a NO-OP when the org repo already holds every community flow', async () => {
    const gh = githubFake({
      writeOk: true, privateRead: true,
      files: {
        'tdd-flow.json': '{ "name": "TDD Flow", "steps": [] }',
        'lean-flow.json': '{ "name": "Lean Flow", "steps": [] }',
      },
    });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });
    gh.calls.length = 0;

    const r = await supertest(app).post('/v1/admin/registry-config/sync')
      .set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.copied).toBe(0);
    expect(r.body.skipped).toBe(COMMUNITY_FLOWS.length);
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('copy stops at the documented bound and reports truncation', async () => {
    // The public registry is writable by contributors; an unbounded copy would
    // turn one save click into an unbounded series of GitHub writes.
    const many = Array.from({ length: 250 }, (_, i) => ({
      name: `Flow ${i}`, author: 'cglab', version: '1.0.0', steps: [{ name: 'A', label: 'A', order: 1 }],
    }));
    // Index the fixtures by the FILE NAME the listing advertises, so a lookup
    // miss is a test bug rather than a silent 404.
    const byFile = new Map(many.map((f, i) => [`f${i}.json`, f]));
    const puts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      // Order matters: the pre-write existence check URL also contains
      // '/contents/flows/', so it is keyed on api.github.com and tested before
      // the raw download_url branch.
      if (method === 'GET' && url.includes('api.github.com') && url.includes('/contents/flows/')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (method === 'GET' && url.includes('/contents/flows?')) {
        return { ok: true, status: 200, json: async () => many.map((_, i) => ({
          name: `f${i}.json`, type: 'file', download_url: `https://pub.test/f${i}.json`,
        })) };
      }
      if (method === 'GET' && url.startsWith('https://pub.test/')) {
        const f = byFile.get(url.split('/').pop()!);
        if (!f) throw new Error(`fixture missing for ${url}`);
        return { ok: true, status: 200, json: async () => f };
      }
      if (method === 'GET' && url.includes(`/repos/${ORG_REPO}`)) {
        return { ok: true, status: 200, json: async () => ({ full_name: ORG_REPO, permissions: { push: true } }) };
      }
      if (method === 'PUT') {
        puts.push(url);
        return { ok: true, status: 201, json: async () => ({ content: { sha: 's' } }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.copied).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(puts).toHaveLength(200);
  });

  it('sync rejects a non-admin', async () => {
    const r = await supertest(app).post('/v1/admin/registry-config/sync').set('Cookie', cookieView);
    expect(r.status).toBe(403);
  });

  // ── Reversibility ─────────────────────────────────────────────────────────
  it('PUT back to the public repo succeeds with NO reverse copy', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });

    gh.calls.length = 0;
    const r = await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: PUBLIC_REPO });
    expect(r.status).toBe(200);
    expect(r.body.repo).toBe(PUBLIC_REPO);
    expect(r.body.isPublic).toBe(true);
    // Community flows are already public — copying back is pointless and would
    // attempt to write into a repo the org has no business writing.
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('moving back to public clears the copy record', async () => {
    // The badge in the admin UI reads copiedAt. If the clear were treated as
    // "not specified", an org sitting on the PUBLIC registry would still be
    // shown "community flows copied" indefinitely.
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });
    expect((await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin)).body.copiedAt).toBeTruthy();

    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: PUBLIC_REPO });
    const after = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieAdmin);
    expect(after.body.repo).toBe(PUBLIC_REPO);
    expect(after.body.copiedAt).toBeNull();
  });

  // ── Browse / install follow the org repo ──────────────────────────────────
  it('GET /v1/admin/registry/flows reads the ORG repo once configured', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_orgtoken_999' });
    gh.calls.length = 0;

    const r = await supertest(app).get('/v1/admin/registry/flows').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    const listing = gh.calls.find((c) => c.method === 'GET' && c.url.includes('/contents/flows?'));
    expect(listing!.url).toContain(ORG_REPO);
    expect(listing!.url).not.toContain(PUBLIC_REPO);
  });

  it('reads send the Authorization header — this is why a private repo works at all', async () => {
    // The pre-existing read path used an ANONYMOUS fetch, which 404s on a
    // private repo. With privateRead enabled the fake returns 404 unless a
    // token rides along, so this test fails against the old behaviour.
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_orgtoken_999' });
    gh.calls.length = 0;

    const r = await supertest(app).get('/v1/admin/registry/flows').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    for (const c of gh.calls) {
      expect(c.auth, `unauthenticated read: ${c.url}`).toBe('Bearer ghp_orgtoken_999');
    }
  });

  it('reads fall back to ANONYMOUS public access when the org is on the public repo', async () => {
    const gh = githubFake({ writeOk: true });
    vi.stubGlobal('fetch', gh.fn);
    const r = await supertest(app).get('/v1/admin/registry/flows').set('Cookie', cookieAdmin);
    expect(r.status).toBe(200);
    const listing = gh.calls.find((c) => c.url.includes('/contents/flows?'));
    expect(listing!.url).toContain(PUBLIC_REPO);
    expect(listing!.auth).toBeUndefined();
  });

  it('POST /v1/admin/flows/install installs from the ORG repo', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_x' });

    // Seed the org repo with a flow file the hub can read back.
    gh.written['lean-flow.json'] = JSON.stringify({
      name: 'Lean Flow', description: 'short', steps: [
        { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
        { name: 'BUILD', label: 'Build', order: 1 },
        { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
      ],
    });

    const r = await supertest(app).post('/v1/admin/flows/install')
      .set('Cookie', cookieAdmin).send({ filename: 'lean-flow.json' });
    expect(r.status).toBe(201);
    const fetch_ = gh.calls.find((c) => c.url.includes('/contents/flows/lean-flow.json'));
    expect(fetch_!.url).toContain(ORG_REPO);
    expect(fetch_!.auth).toBe('Bearer ghp_x');
  });

  // ── Isolation ─────────────────────────────────────────────────────────────
  it('a token stored for one org is never used for another', async () => {
    const gh = githubFake({ writeOk: true, privateRead: true });
    vi.stubGlobal('fetch', gh.fn);
    await supertest(app).put('/v1/admin/registry-config')
      .set('Cookie', cookieAdmin).send({ repo: ORG_REPO, token: 'ghp_orgA_token' });

    // Second org in the same hub must start clean.
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run('INSERT OR IGNORE INTO auth_config (org_id, password_enabled) VALUES (?, 1)', ['org-b']);
    await createPasswordUser(ctx.db, 'org-b', 'admin@b', 'longenough1', 'admin');
    const cookieB = await loginAs(app, 'admin@b', 'longenough1');
    const r = await supertest(app).get('/v1/admin/registry-config').set('Cookie', cookieB);
    expect(r.body.repo).toBe(PUBLIC_REPO);
    expect(r.body.hasToken).toBe(false);
  });
});
