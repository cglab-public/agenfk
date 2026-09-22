import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { loginAs } from './helpers/loginAs';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { saveRegistryConfig } from '../services/flowRegistry';

/**
 * CGLAB-368 — a hub admin sees the open pull requests on the org's flow
 * registry, so the flows installations publish (CGLAB-367) can be reviewed and
 * merged. The hub only LISTS: each entry links to the pull request on GitHub,
 * where the review and the merge happen.
 */

const SECRET = 'a'.repeat(64);
const ORG_REPO = 'acme-corp/agenfk-flows';
const ORG_BRANCH = 'release';
const ORG_TOKEN = 'ghp_orgtoken_pulls';

interface Call { method: string; url: string; path: string; query: URLSearchParams; auth?: string }

const PULLS = [
  {
    number: 12, title: 'Add flow: Review Heavy Flow', html_url: `https://github.com/${ORG_REPO}/pull/12`,
    user: { login: 'acme-bot' }, created_at: '2026-09-22T10:00:00Z', draft: false,
    head: { ref: 'flow/review-heavy-flow' }, base: { ref: ORG_BRANCH },
  },
  {
    number: 11, title: 'Update flow: Lean Flow', html_url: `https://github.com/${ORG_REPO}/pull/11`,
    user: { login: 'dana' }, created_at: '2026-09-21T09:00:00Z', draft: true,
    head: { ref: 'flow/lean-flow' }, base: { ref: ORG_BRANCH },
  },
];

function githubFake(opts: { status?: number; pulls?: unknown[]; link?: string; repo?: string } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    const u = new URL(url);
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, path: u.pathname, query: u.searchParams, auth: init?.headers?.Authorization });
    if (u.pathname === `/repos/${opts.repo ?? ORG_REPO}/pulls`) {
      const status = opts.status ?? 200;
      const body = status === 200 ? (opts.pulls ?? PULLS) : { message: 'Bad credentials' };
      return {
        ok: status === 200, status, json: async () => body,
        headers: { get: (h: string) => (h.toLowerCase() === 'link' ? opts.link ?? null : null) },
      } as any;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fn, calls };
}

describe('GET /v1/admin/registry/pulls (CGLAB-368)', () => {
  let server: any;
  let db: any;
  let cookieAdmin: string;
  let cookieView: string;

  const list = (cookie = cookieAdmin) => supertest(server).get('/v1/admin/registry/pulls').set('Cookie', cookie);

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a', db,
    });
    server = out.app.listen(0);
    await createPasswordUser(out.ctx.db, 'org-a', 'admin@x', 'longenough1', 'admin');
    await createPasswordUser(out.ctx.db, 'org-a', 'view@x', 'longenough1', 'viewer');
    cookieAdmin = await loginAs(out.app, 'admin@x', 'longenough1');
    cookieView = await loginAs(out.app, 'view@x', 'longenough1');
    await saveRegistryConfig(db, 'org-a', {
      repo: ORG_REPO, branch: ORG_BRANCH, token: ORG_TOKEN, secretKey: SECRET, copiedAt: null,
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    vi.unstubAllGlobals();
  });

  it('lists the open pull requests against the org registry branch', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ repo: ORG_REPO, branch: ORG_BRANCH, isPublic: false });
    expect(res.body.pulls).toEqual([
      { number: 12, title: 'Add flow: Review Heavy Flow', url: `https://github.com/${ORG_REPO}/pull/12`, author: 'acme-bot', createdAt: '2026-09-22T10:00:00Z', draft: false, headBranch: 'flow/review-heavy-flow' },
      { number: 11, title: 'Update flow: Lean Flow', url: `https://github.com/${ORG_REPO}/pull/11`, author: 'dana', createdAt: '2026-09-21T09:00:00Z', draft: true, headBranch: 'flow/lean-flow' },
    ]);
  });

  it('asks GitHub for OPEN pull requests into the registry branch, with the org token, on the org repo only', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    await list();
    expect(gh.calls).toHaveLength(1);
    const c = gh.calls[0];
    expect(c.method).toBe('GET');
    expect(c.path).toBe(`/repos/${ORG_REPO}/pulls`);
    expect(c.query.get('state')).toBe('open');
    expect(c.query.get('base')).toBe(ORG_BRANCH);
    expect(c.auth).toBe(`Bearer ${ORG_TOKEN}`);
    expect(c.query.get('per_page')).toBe('100');
  });

  it('drops any entry whose link is not an https://github.com/ address', async () => {
    // Defence in depth: whatever answers as GitHub, the admin must never be
    // handed a javascript: or look-alike link to click.
    const gh = githubFake({
      pulls: [
        { ...PULLS[0], html_url: 'javascript:alert(1)' },
        { ...PULLS[1], html_url: 'https://github.com.evil.test/x/pull/1' },
        { ...PULLS[0], number: 13, html_url: `https://github.com/${ORG_REPO}/pull/13` },
      ],
    });
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.body.pulls.map((p: any) => p.number)).toEqual([13]);
  });

  it('tells an org on the PUBLIC registry so, without listing every community PR', async () => {
    await saveRegistryConfig(db, 'org-a', {
      repo: 'cglab-public/agenfk-flows', branch: 'main', token: null, secretKey: SECRET, copiedAt: null,
    });
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ repo: 'cglab-public/agenfk-flows', isPublic: true, pulls: [] });
    expect(gh.calls).toEqual([]);
  });

  it('reports a GitHub failure as an error, never as an empty list', async () => {
    const gh = githubFake({ status: 401 });
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.status).toBe(502);
    expect(res.body.error).toContain(ORG_REPO);
    expect(res.body.pulls).toBeUndefined();
  });

  it('is for admins only', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    expect((await list(cookieView)).status).toBe(403);
    expect((await supertest(server).get('/v1/admin/registry/pulls')).status).toBe(401);
    expect(gh.calls).toEqual([]);
  });

  // ── review round 2 ───────────────────────────────────────────────────────

  it('says the list was cut off when GitHub has more than one page (A2)', async () => {
    const gh = githubFake({ link: `<https://api.github.com/repos/${ORG_REPO}/pulls?page=2>; rel="next", <https://api.github.com/repos/${ORG_REPO}/pulls?page=3>; rel="last"` });
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.body.truncated).toBe(true);
    expect(res.body.allUrl).toBe(`https://github.com/${ORG_REPO}/pulls`);
  });

  it('reports a complete list as not truncated', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    expect((await list()).body.truncated).toBe(false);
  });

  it('names the missing permission when the token cannot read pull requests', async () => {
    const gh = githubFake({ status: 403 });
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/pull-requests: read/);
  });

  it('refuses a private registry with no stored token, before calling GitHub', async () => {
    await db.run('UPDATE org_settings SET registry_token_enc = NULL WHERE org_id = ?', ['org-a']);
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    const res = await list();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/token/i);
    expect(gh.calls).toEqual([]);
  });

  it('shows an admin their OWN org\'s registry only', async () => {
    const OTHER = 'globex/flows';
    await saveRegistryConfig(db, 'org-b', { repo: OTHER, branch: 'main', token: 'ghp_orgb', secretKey: SECRET, copiedAt: null });
    await createPasswordUser(db, 'org-b', 'admin@b', 'longenough1', 'admin');
    const cookieB = await loginAs(server, 'admin@b', 'longenough1');
    const gh = githubFake({ repo: OTHER, pulls: [] });
    vi.stubGlobal('fetch', gh.fn);
    const res = await list(cookieB);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.repo).toBe(OTHER);
    for (const c of gh.calls) {
      expect(c.path.startsWith(`/repos/${OTHER}/`)).toBe(true);
      expect(c.auth).toBe('Bearer ghp_orgb');
    }
  });
});
