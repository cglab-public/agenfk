import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { issueApiKey } from '../auth/apiKey';
import { saveRegistryConfig, serializeRegistryFlow } from '../services/flowRegistry';

/**
 * CGLAB-367 — publishing a flow from an installation goes to the ORG's
 * hub-configured registry, through the hub.
 *
 * The local flow editor's Publish always went to the public community repo,
 * using the laptop's own `gh` login, while browse and install had already moved
 * behind the hub (CGLAB-138): the org's GitHub token lives on the hub and is
 * never copied to laptops. Publishing follows the same rule. The hub commits the
 * flow file on the branch `flow/<slug>` and opens (or updates) a pull request
 * back to the registry branch - the admin reviews and merges it on GitHub.
 * Nothing is ever written straight onto the registry branch.
 */

const SECRET = 'a'.repeat(64);
const ORG_REPO = 'acme-corp/agenfk-flows';
const ORG_BRANCH = 'release';
const ORG_TOKEN = 'ghp_orgtoken_publish';
const BASE_SHA = 'b'.repeat(40);
const FILE = 'review-heavy-flow.json';
const HEAD_BRANCH = 'flow/review-heavy-flow';

const FLOW = {
  name: 'Review Heavy Flow',
  description: 'Two reviews before done',
  version: '1.2.0',
  steps: [
    { id: 'uuid-todo', name: 'TODO', label: 'To Do', order: 0, isAnchor: true, exitCriteria: '' },
    { id: 'uuid-build', name: 'BUILD', label: 'Build', order: 1, exitCriteria: 'it builds' },
    { id: 'uuid-done', name: 'DONE', label: 'Done', order: 2, isAnchor: true, exitCriteria: '' },
  ],
};

interface Call { method: string; url: string; path: string; query: URLSearchParams; auth?: string; body?: any }

/** base64 the way GitHub's Contents API returns it: wrapped every 60 chars. */
const ghBase64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');

/**
 * A GitHub fake that records every call.
 *  - `baseFile`   content of flows/<file> on the registry branch (undefined = absent)
 *  - `headBranch` whether flow/<slug> already exists, and `headFile` its content there
 *  - `openPr`     an open PR from flow/<slug> into the registry branch
 *  - statuses for the calls a test wants to fail
 */
function githubFake(opts: {
  repo?: string; token?: string; base?: string;
  baseFile?: string; headBranch?: boolean; headFile?: string; openPr?: boolean;
  /** The base the open PR targets (defaults to the registry branch). */
  openPrBase?: string;
  /** Commits on flow/<slug> that the registry branch lacks, and whether its tip is in a MERGED PR. */
  aheadBy?: number; tipMerged?: boolean;
  baseHeadStatus?: number; putStatus?: number; prStatus?: number; refCreateStatus?: number;
} = {}) {
  const repo = opts.repo ?? ORG_REPO;
  const base = opts.base ?? ORG_BRANCH;
  const calls: Call[] = [];
  const res = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const fn = vi.fn(async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    const call: Call = {
      method, url, path: decodeURIComponent(u.pathname), query: u.searchParams,
      auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = `/repos/${repo}`;
    const p = call.path;
    if (method === 'GET' && p === `${r}/git/ref/heads/${base}`) {
      const s = opts.baseHeadStatus ?? 200;
      return s === 200 ? res(200, { object: { sha: BASE_SHA } }) : res(s, { message: 'Not Found' });
    }
    if (method === 'GET' && p.startsWith(`${r}/git/ref/heads/flow/`)) {
      return opts.headBranch ? res(200, { object: { sha: 'c'.repeat(40) } }) : res(404, { message: 'Not Found' });
    }
    if (method === 'GET' && p.startsWith(`${r}/contents/flows/`)) {
      const ref = u.searchParams.get('ref');
      const onHead = !!ref && ref.startsWith('flow/');
      const content = onHead ? opts.headFile : (ref === BASE_SHA ? opts.baseFile : undefined);
      if (!onHead && ref !== BASE_SHA) return res(400, { message: `unexpected ref ${ref}` });
      if (content === undefined) return res(404, { message: 'Not Found' });
      return res(200, { sha: onHead ? 'e'.repeat(40) : 'f'.repeat(40), content: ghBase64(content) });
    }
    if (method === 'GET' && p === `${r}/pulls`) {
      // Like GitHub: filtered by the head the caller names, each PR carrying its base.
      const owner = repo.split('/')[0];
      const head = u.searchParams.get('head');
      const wanted = !!head && head.startsWith(`${owner}:flow/`);
      const baseQ = u.searchParams.get('base');
      const prBase = opts.openPrBase ?? base;
      if (!opts.openPr || !wanted || (baseQ && baseQ !== prBase)) return res(200, []);
      return res(200, [{ number: 3, html_url: `https://github.com/${repo}/pull/3`, base: { ref: prBase } }]);
    }
    if (method === 'GET' && p.startsWith(`${r}/compare/`)) {
      return res(200, { ahead_by: opts.aheadBy ?? 0, behind_by: 0 });
    }
    if (method === 'GET' && /\/commits\/[0-9a-f]+\/pulls$/.test(p)) {
      return res(200, opts.tipMerged ? [{ number: 2, merged_at: '2026-09-01T00:00:00Z' }] : []);
    }
    if (method === 'POST' && p === `${r}/git/refs`) {
      const st = opts.refCreateStatus ?? 201;
      return st < 300 ? res(201, { ref: call.body.ref }) : res(st, { message: 'Reference already exists' });
    }
    if (method === 'PATCH' && p.startsWith(`${r}/git/refs/heads/flow/`)) return res(200, {});
    if (method === 'DELETE' && p.startsWith(`${r}/git/refs/heads/flow/`)) return res(204, {});
    if (method === 'PUT' && p.startsWith(`${r}/contents/flows/`)) {
      const s = opts.putStatus ?? 201;
      return res(s, s < 300 ? { content: { path: p } } : { message: 'refused' });
    }
    if (method === 'POST' && p === `${r}/pulls`) {
      const s = opts.prStatus ?? 201;
      if (s >= 300) return res(s, { message: 'Resource not accessible by personal access token' });
      return res(201, { number: 7, html_url: `https://github.com/${repo}/pull/7` });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { fn, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

describe('POST /v1/registry/flows/publish (CGLAB-367)', () => {
  let server: any;
  let db: any;
  let key: string;

  const publish = (body: unknown, token: string | null = key) => {
    const r = supertest(server).post('/v1/registry/flows/publish');
    return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body as object);
  };

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({
      dbPath: ':memory:', secretKey: SECRET, sessionSecret: 'test-session-secret',
      defaultOrgId: 'org-a', db,
    });
    server = out.app.listen(0);
    key = await issueApiKey(db, 'org-a', 'laptop', { installationId: 'inst-1' });
    await saveRegistryConfig(db, 'org-a', {
      repo: ORG_REPO, branch: ORG_BRANCH, token: ORG_TOKEN, secretKey: SECRET, copiedAt: null,
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
    vi.unstubAllGlobals();
  });

  it('opens a pull request from flow/<slug>, cut from the registry branch, with the hub-held token', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);

    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'pr', url: `https://github.com/${ORG_REPO}/pull/7`, repo: ORG_REPO, branch: HEAD_BRANCH, base: ORG_BRANCH });

    const ref = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/refs'))!;
    expect(ref.body).toEqual({ ref: `refs/heads/${HEAD_BRANCH}`, sha: BASE_SHA });
    const put = gh.calls.find((c) => c.method === 'PUT')!;
    expect(put.body.branch, 'the file must land on the PR branch').toBe(HEAD_BRANCH);
    const pr = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect(pr.body).toMatchObject({ head: HEAD_BRANCH, base: ORG_BRANCH });

    for (const c of gh.calls) {
      expect(c.path.startsWith(`/repos/${ORG_REPO}/`), `${c.method} ${c.url}`).toBe(true);
      expect(c.auth, `${c.method} ${c.url}`).toBe(`Bearer ${ORG_TOKEN}`);
    }
  });

  it('never writes onto the registry branch itself', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    await publish({ flow: FLOW, publisher: 'dana@acme' });
    const puts = gh.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body.branch).toBe(HEAD_BRANCH);
  });

  it('reads the file at the SAME commit the branch is cut from', async () => {
    // Reading by branch name, then cutting at a head read afterwards, let the
    // base move in between: the blob sha no longer matched the new branch.
    const gh = githubFake({ baseFile: '{"name":"Review Heavy Flow","version":"1.0.0","steps":[]}\n' });
    vi.stubGlobal('fetch', gh.fn);
    await publish({ flow: FLOW, publisher: 'dana@acme' });
    const read = gh.calls.find((c) => c.method === 'GET' && c.path.endsWith(`/contents/flows/${FILE}`))!;
    expect(read.query.get('ref')).toBe(BASE_SHA);
    const put = gh.calls.find((c) => c.method === 'PUT')!;
    expect(put.body.sha, 'an overwrite must carry the file\'s sha').toBe('f'.repeat(40));
  });

  it('writes the normalised registry document, crediting the publisher', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    await publish({ flow: FLOW, publisher: 'dana@acme' });
    const put = gh.calls.find((c) => c.method === 'PUT')!;
    const doc = JSON.parse(Buffer.from(put.body.content, 'base64').toString('utf8'));
    expect(doc).toMatchObject({ name: FLOW.name, description: FLOW.description, version: '1.2.0', author: 'dana@acme' });
    expect(doc.steps.map((s: any) => s.name)).toEqual(['TODO', 'BUILD', 'DONE']);
    for (const s of doc.steps) expect(s).not.toHaveProperty('id');
  });

  it('answers "existing" and writes nothing when the registry branch already has this flow', async () => {
    const gh = githubFake({ baseFile: serializeRegistryFlow(FLOW, 'dana@acme') });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.kind).toBe('existing');
    expect(res.body.url).toBe(`https://github.com/${ORG_REPO}/blob/${ORG_BRANCH}/flows/${FILE}`);
    expect(writes(gh.calls)).toEqual([]);
  });

  it('treats a flow that differs only in who published it as already there', async () => {
    // Otherwise a second person re-publishing an unchanged flow opens a PR
    // whose only change is overwriting the original author's credit.
    const gh = githubFake({ baseFile: serializeRegistryFlow(FLOW, 'alice@acme') });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'bob@acme' });
    expect(res.body.kind).toBe('existing');
    expect(writes(gh.calls)).toEqual([]);
  });

  it('re-publishing while the PR is open updates THAT pull request instead of opening another', async () => {
    const gh = githubFake({ headBranch: true, headFile: '{"name":"Review Heavy Flow","version":"1.1.0","steps":[]}\n', openPr: true });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'pr', url: `https://github.com/${ORG_REPO}/pull/3`, branch: HEAD_BRANCH });
    expect(gh.calls.some((c) => c.method === 'POST'), 'no new branch and no new PR').toBe(false);
    const put = gh.calls.find((c) => c.method === 'PUT')!;
    expect(put.body.branch).toBe(HEAD_BRANCH);
    expect(put.body.sha, 'the update must carry the sha of the file ON the PR branch').toBe('e'.repeat(40));
  });

  it('re-publishing the exact content already on the open PR writes nothing', async () => {
    const gh = githubFake({ headBranch: true, headFile: serializeRegistryFlow(FLOW, 'dana@acme'), openPr: true });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.body).toMatchObject({ kind: 'pr', url: `https://github.com/${ORG_REPO}/pull/3` });
    expect(writes(gh.calls)).toEqual([]);
  });

  it('resets a stale flow/<slug> branch (no open PR) to the registry branch before reusing it', async () => {
    // Left behind by a PR that was merged or closed: committing on top of it
    // would propose an old base.
    const gh = githubFake({ headBranch: true, openPr: false });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.body.kind).toBe('pr');
    const reset = gh.calls.find((c) => c.method === 'PATCH')!;
    expect(reset, 'the stale branch was not reset').toBeDefined();
    expect(reset.body).toEqual({ sha: BASE_SHA, force: true });
    expect(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs'))).toBe(false);
  });

  it('deletes the branch it just created when writing the file fails', async () => {
    const gh = githubFake({ putStatus: 422 });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(502);
    expect(gh.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(`/git/refs/heads/${HEAD_BRANCH}`))).toBe(true);
  });

  it('keeps untrusted text inert in the pull request, and records the installation', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    await publish({
      flow: { ...FLOW, name: 'Ping @acme-corp/everyone', description: '![x](https://evil.test/p.png) cc @ceo' },
      publisher: 'mallory** (verified by admin)',
    });
    const pr = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    const body: string = pr.body.body;
    // A mention or an image only renders outside code; every untrusted value
    // must sit inside one.
    const outsideCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    expect(outsideCode).not.toMatch(/@acme-corp|@ceo|!\[|evil\.test|verified by admin/);
    expect(body).toContain('inst-1');
    expect(pr.body.title).not.toMatch(/@acme-corp/);
  });

  it('bounds the name and description, and requires every step to have a name', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    expect((await publish({ flow: { ...FLOW, name: 'x'.repeat(101) } })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, description: 'd'.repeat(2001) } })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, description: 42 } })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, steps: [{ label: 'no name' }] } })).status).toBe(400);
    expect(gh.calls).toEqual([]);
  });

  it('handles a registry branch whose name contains a slash', async () => {
    await saveRegistryConfig(db, 'org-a', {
      repo: ORG_REPO, branch: 'release/2.0', token: ORG_TOKEN, secretKey: SECRET, copiedAt: null,
    });
    const gh = githubFake({ base: 'release/2.0' });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pr = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))!;
    expect(pr.body.base).toBe('release/2.0');
  });

  it('says the registry branch is not visible, rather than blaming a permission', async () => {
    const gh = githubFake({ baseHeadStatus: 404 });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not visible|does not exist/i);
    expect(res.body.error).not.toMatch(/needs contents/i);
    expect(writes(gh.calls)).toEqual([]);
  });

  it('names the missing permission when the token cannot open pull requests', async () => {
    const gh = githubFake({ prStatus: 403 });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pull-requests: write/);
    expect(res.body.error).toContain(ORG_REPO);
  });

  it('tells an org on the PUBLIC registry so, and sends nothing to GitHub', async () => {
    await saveRegistryConfig(db, 'org-a', {
      repo: 'cglab-public/agenfk-flows', branch: 'main', token: null, secretKey: SECRET, copiedAt: null,
    });
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(409);
    expect(res.body.public).toBe(true);
    expect(gh.calls).toEqual([]);
  });

  it('refuses a private registry with no stored token, before calling GitHub', async () => {
    await db.run('UPDATE org_settings SET registry_token_enc = NULL WHERE org_id = ?', ['org-a']);
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/token/i);
    expect(gh.calls).toEqual([]);
  });

  it('publishes for the key\'s OWN org only: another org\'s repo and token are never used', async () => {
    const OTHER_REPO = 'globex/flows';
    await saveRegistryConfig(db, 'org-b', {
      repo: OTHER_REPO, branch: 'main', token: 'ghp_orgb_token', secretKey: SECRET, copiedAt: null,
    });
    const keyB = await issueApiKey(db, 'org-b', 'laptop-b', { installationId: 'inst-b' });
    const gh = githubFake({ repo: OTHER_REPO, base: 'main' });
    vi.stubGlobal('fetch', gh.fn);

    const res = await publish({ flow: FLOW, publisher: 'eve@globex' }, keyB);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const c of gh.calls) {
      expect(c.path.startsWith(`/repos/${OTHER_REPO}/`), c.url).toBe(true);
      expect(c.auth).toBe('Bearer ghp_orgb_token');
    }
  });

  it('ignores a repo named by the caller - the org\'s configured registry is the only target', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    await publish({ flow: FLOW, publisher: 'dana@acme', repo: 'victim/corp-secrets', registry: 'victim/corp-secrets' });
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const c of gh.calls) expect(c.url).not.toContain('victim');
  });

  it('rejects a missing flow, or a name with nothing usable in it, before calling GitHub', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    expect((await publish({ publisher: 'x' })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, name: '!!!' } })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, steps: 'nope' } })).status).toBe(400);
    expect(gh.calls).toEqual([]);
  });

  it('requires an installation api key', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    expect((await publish({ flow: FLOW }, null)).status).toBe(401);
    expect(gh.calls).toEqual([]);
  });

  // ── versions (review of the local half, finding 5) ───────────────────────
  // The laptop's gh path bumps the patch version on every re-publish; the hub
  // path must too, or every update PR ships the same version and installers
  // cannot tell them apart.
  const putDoc = (calls: Call[]) => {
    const put = calls.find((c) => c.method === 'PUT')!;
    return JSON.parse(Buffer.from(put.body.content, 'base64').toString('utf8'));
  };

  it('bumps the patch version of a flow that changed since the registry last had it', async () => {
    const onRegistry = serializeRegistryFlow({ ...FLOW, version: '1.0.3', steps: FLOW.steps.slice(0, 2) }, 'alice@acme');
    const gh = githubFake({ baseFile: onRegistry });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: { ...FLOW, version: '1.0.0' }, publisher: 'dana@acme' });
    expect(res.body).toMatchObject({ kind: 'pr', version: '1.0.4' });
    expect(putDoc(gh.calls).version).toBe('1.0.4');
  });

  it('keeps a version the author already moved past the registry\'s', async () => {
    const onRegistry = serializeRegistryFlow({ ...FLOW, version: '1.0.3', steps: FLOW.steps.slice(0, 2) }, 'alice@acme');
    const gh = githubFake({ baseFile: onRegistry });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: { ...FLOW, version: '2.0.0' }, publisher: 'dana@acme' });
    expect(res.body.version).toBe('2.0.0');
    expect(putDoc(gh.calls).version).toBe('2.0.0');
  });

  it('a version-only difference is not a change: "existing", reporting the registry\'s version', async () => {
    const onRegistry = serializeRegistryFlow({ ...FLOW, version: '1.0.3' }, 'alice@acme');
    const gh = githubFake({ baseFile: onRegistry });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: { ...FLOW, version: '1.0.0' }, publisher: 'dana@acme' });
    expect(res.body).toMatchObject({ kind: 'existing', version: '1.0.3' });
    expect(writes(gh.calls)).toEqual([]);
  });

  it('publishes a brand-new flow at the version it carries', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.body.version).toBe('1.2.0');
    expect(putDoc(gh.calls).version).toBe('1.2.0');
  });

  // ── review round 2 ───────────────────────────────────────────────────────

  it('looks up the open pull request by its head branch, whatever its base (B1, B4)', async () => {
    const gh = githubFake({ headBranch: true, headFile: '{"name":"x","steps":[]}\n', openPr: true });
    vi.stubGlobal('fetch', gh.fn);
    await publish({ flow: FLOW, publisher: 'dana@acme' });
    const q = gh.calls.find((c) => c.method === 'GET' && c.path.endsWith('/pulls'))!;
    expect(q.query.get('head')).toBe(`acme-corp:${HEAD_BRANCH}`);
    expect(q.query.get('state')).toBe('open');
    expect(q.query.has('base'), 'a base filter hides a PR against another branch').toBe(false);
  });

  it('refuses when the flow\'s open pull request targets a different branch (B1)', async () => {
    // e.g. the admin moved the registry branch while a PR against the old one
    // was open. Resetting flow/<slug> would wipe that PR's reviewed commits.
    const gh = githubFake({ headBranch: true, openPr: true, openPrBase: 'main' });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('pull/3');
    expect(res.body.error).toContain('main');
    expect(writes(gh.calls)).toEqual([]);
  });

  it('never force-resets a branch that carries commits no merged pull request contains (B1)', async () => {
    const gh = githubFake({ headBranch: true, openPr: false, aheadBy: 2, tipMerged: false });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(HEAD_BRANCH);
    expect(gh.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(writes(gh.calls)).toEqual([]);
  });

  it('does reset a branch whose commits were merged, even by squash (B1)', async () => {
    // A squash merge gives new SHAs, so "ahead" alone would lock the flow out
    // forever; the tip belonging to a MERGED pull request is what makes it safe.
    const gh = githubFake({ headBranch: true, openPr: false, aheadBy: 2, tipMerged: true });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.body.kind).toBe('pr');
    expect(gh.calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('writes to the open pull request when only the version changed there (B2)', async () => {
    // The PR holds 2.0.0; the author now publishes 3.0.0. Skipping the write
    // while reporting 3.0.0 made the laptop record a version the PR lacks.
    const gh = githubFake({ headBranch: true, headFile: serializeRegistryFlow({ ...FLOW, version: '2.0.0' }, 'dana@acme'), openPr: true });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: { ...FLOW, version: '3.0.0' }, publisher: 'dana@acme' });
    expect(res.body).toMatchObject({ kind: 'pr', version: '3.0.0' });
    const put = gh.calls.find((c) => c.method === 'PUT');
    expect(put, 'the version change was not written to the PR').toBeDefined();
    expect(JSON.parse(Buffer.from(put!.body.content, 'base64').toString('utf8')).version).toBe('3.0.0');
  });

  it('says so when the registry already matches but an open pull request still proposes a change (B3)', async () => {
    const gh = githubFake({
      baseFile: serializeRegistryFlow(FLOW, 'dana@acme'),
      headBranch: true, headFile: '{"name":"Review Heavy Flow","steps":[]}\n', openPr: true,
    });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.body.kind).toBe('existing');
    expect(res.body.note).toContain(`https://github.com/${ORG_REPO}/pull/3`);
    expect(writes(gh.calls)).toEqual([]);
  });

  it('never publishes below the registry\'s version, prereleases included', async () => {
    const changed = { ...FLOW, steps: FLOW.steps.slice(0, 2) };
    let gh = githubFake({ baseFile: serializeRegistryFlow({ ...changed, version: '2.0.0-beta.1' }, 'a') });
    vi.stubGlobal('fetch', gh.fn);
    let res = await publish({ flow: { ...FLOW, version: '1.0.0' }, publisher: 'dana@acme' });
    expect(res.body.version).toBe('2.0.1');

    gh = githubFake({ baseFile: serializeRegistryFlow({ ...changed, version: '1.0.0' }, 'a') });
    vi.stubGlobal('fetch', gh.fn);
    res = await publish({ flow: { ...FLOW, version: '2.0.0-rc.1' }, publisher: 'dana@acme' });
    expect(res.body.version).toBe('2.0.0-rc.1');
  });

  it('bounds the version and each step\'s text', async () => {
    const gh = githubFake();
    vi.stubGlobal('fetch', gh.fn);
    expect((await publish({ flow: { ...FLOW, version: '1'.repeat(51) } })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, steps: [{ name: 'A', label: 'l'.repeat(201) }] } })).status).toBe(400);
    expect((await publish({ flow: { ...FLOW, steps: [{ name: 'A', exitCriteria: 'e'.repeat(10001) }] } })).status).toBe(400);
    expect(gh.calls).toEqual([]);
  });

  it('answers a publish that lost a race with the pull request the winner opened', async () => {
    // Two publishes of the same new flow: GitHub refuses the second PR as a
    // duplicate. The flow IS proposed, so say where instead of reporting 502.
    const gh = githubFake({ prStatus: 422 });
    const fn = gh.fn;
    let prTries = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const r = await fn(url, init);
      if ((init?.method ?? 'GET') === 'POST' && String(url).endsWith('/pulls')) prTries++;
      return r;
    }));
    // After the refused create, the lookup finds the winner's PR.
    const orig = gh.fn.getMockImplementation()!;
    gh.fn.mockImplementation(async (url: string, init?: any) => {
      if (prTries > 0 && (init?.method ?? 'GET') === 'GET' && String(url).includes('/pulls?')) {
        return { ok: true, status: 200, json: async () => [{ number: 5, html_url: `https://github.com/${ORG_REPO}/pull/5`, base: { ref: ORG_BRANCH } }] } as any;
      }
      return orig(url, init);
    });
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.url).toBe(`https://github.com/${ORG_REPO}/pull/5`);
  });

  it('asks a second concurrent publisher to retry when the branch appeared under it', async () => {
    const gh = githubFake({ refCreateStatus: 422 });
    vi.stubGlobal('fetch', gh.fn);
    const res = await publish({ flow: FLOW, publisher: 'dana@acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/again/i);
  });
});
