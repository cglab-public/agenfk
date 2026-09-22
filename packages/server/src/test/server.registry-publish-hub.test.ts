/**
 * CGLAB-367 — Publish from a hub-connected installation goes to the ORG's
 * registry, through the hub.
 *
 * Browse and install already asked the hub (CGLAB-138); publish still pushed to
 * the public community repo with the laptop's own `gh` login, so an org that
 * moved to a private registry published its flows to the one place it had moved
 * away from. The local server now forwards the flow to the hub, which opens the
 * pull request on the org's repo with the token it holds.
 *
 * The same no-fallback rule as browse: when the hub is unreachable or refuses,
 * the answer is an error, never a quiet publish to the public registry. The
 * ONE case that stays on the laptop's gh path is the hub saying the org itself
 * uses the public registry.
 *
 * Hub config is forced via env BEFORE the dynamic server import, as in
 * server.registry-hub.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const TEST_DB = path.resolve('./server-registry-publish-hub-test-db.sqlite');
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'AGENFK_HUB_URL', 'AGENFK_HUB_TOKEN', 'AGENFK_HUB_ORG',
  'AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS', 'AGENFK_DB_PATH',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, initStorage: any;
let __server: any;
const agent = () => request(__server);

/** Every child_process call, so a test can see whether the laptop's gh ran. */
const execSync = vi.fn();
const execFileSync = vi.fn();
/** Async execFile, callback last. Default: gh is not installed. */
const execFile = vi.fn();
const ghMissing = (...a: any[]) => { const cb = a[a.length - 1]; if (typeof cb === 'function') cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })); };
vi.mock('child_process', () => ({
  execSync: (...a: unknown[]) => execSync(...a),
  execFileSync: (...a: unknown[]) => execFileSync(...a),
  execFile: (...a: unknown[]) => execFile(...a),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('axios', () => {
  const m = vi.fn() as any;
  m.get = vi.fn(async () => ({ data: [] }));
  m.post = vi.fn();
  m.create = vi.fn(() => m);
  return { default: m };
});

type Reply = { status: number; body?: any; nonJson?: boolean } | { error: string; errorName?: string };
let publishReply: Reply = { status: 200, body: {} };
const publishCalls: Array<{ url: string; auth?: string; body: any }> = [];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith('/v1/registry/flows/publish')) {
      publishCalls.push({ url: u, auth: init?.headers?.Authorization, body: JSON.parse(init?.body ?? '{}') });
      const r = publishReply;
      if ('error' in r) throw Object.assign(new Error(r.error), r.errorName ? { name: r.errorName } : {});
      return {
        status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: () => null },
        json: async () => { if (r.nonJson) throw new SyntaxError('Unexpected token <'); return r.body; },
      } as any;
    }
    // Anything else the server reaches for at startup: harmless and empty.
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ([]) } as any;
  }));
}

/** Did anything try the laptop's own gh / git publish path? */
const ghPathTried = () =>
  execSync.mock.calls.some(([cmd]) => /^gh\b/.test(String(cmd)))
  || execFileSync.mock.calls.some(([bin]) => bin === 'gh');

const FLOW = {
  name: 'Review Heavy Flow',
  description: 'Two reviews before done',
  steps: [
    { name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { name: 'BUILD', label: 'Build', order: 1, exitCriteria: 'it builds' },
    { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
};

describe('POST /registry/flows/publish with a hub connection (CGLAB-367)', () => {
  let flowId: string;

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENFK_HUB_URL = 'http://hub.example.test';
    process.env.AGENFK_HUB_TOKEN = 'agk_test';
    process.env.AGENFK_HUB_ORG = 'org-test';
    process.env.AGENFK_HUB_FLOW_SYNC_FIRST_DELAY_MS = '3600000';
    process.env.AGENFK_DB_PATH = TEST_DB;
    stubFetch();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    ({ app, initStorage } = await import('../server'));
    __server = app.listen(0);
    await initStorage();
    const made = await agent().post('/flows').send(FLOW);
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    flowId = made.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => __server.close(() => r()));
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  beforeEach(() => {
    publishCalls.length = 0;
    execSync.mockReset();
    execFileSync.mockReset();
    execFile.mockReset();
    execFile.mockImplementation(ghMissing);
    publishReply = {
      status: 200,
      body: { kind: 'pr', url: 'https://github.com/acme-corp/agenfk-flows/pull/7', repo: 'acme-corp/agenfk-flows', branch: 'flow/review-heavy-flow-x', base: 'main' },
    };
    stubFetch();
  });

  it('sends the flow to the hub with the installation token, and returns the org PR', async () => {
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'pr', url: 'https://github.com/acme-corp/agenfk-flows/pull/7', repo: 'acme-corp/agenfk-flows' });

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].url).toBe('http://hub.example.test/v1/registry/flows/publish');
    expect(publishCalls[0].auth).toBe('Bearer agk_test');
    expect(publishCalls[0].body.flow.name).toBe(FLOW.name);
    expect(publishCalls[0].body.flow.steps.map((s: any) => s.name)).toEqual(['TODO', 'BUILD', 'DONE']);
    expect(typeof publishCalls[0].body.publisher).toBe('string');
  });

  it('never runs the laptop\'s gh when the hub publishes', async () => {
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(ghPathTried()).toBe(false);
  });

  it('passes an "already published" answer through, with its repo', async () => {
    publishReply = { status: 200, body: { kind: 'existing', url: 'https://github.com/acme-corp/agenfk-flows/blob/main/flows/review-heavy-flow.json', repo: 'acme-corp/agenfk-flows' } };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'existing', repo: 'acme-corp/agenfk-flows' });
  });

  it('keeps the laptop\'s gh path when the hub says the org uses the PUBLIC registry', async () => {
    publishReply = { status: 409, body: { error: 'public registry', public: true, repo: 'cglab-public/agenfk-flows' } };
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls).toHaveLength(1); // asked the hub first
    expect(ghPathTried(), 'the public-registry org should publish with gh as before').toBe(true);
  });

  it('does NOT fall back to the public registry when the hub is unreachable', async () => {
    publishReply = { error: 'ECONNREFUSED' };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/hub/i);
    expect(res.body.error).toMatch(/not .*public registry/i);
    expect(ghPathTried()).toBe(false);
  });

  it('passes a hub refusal through with its status and reason, without falling back', async () => {
    publishReply = { status: 403, body: { error: 'the org registry token cannot open pull requests on acme-corp/agenfk-flows (it needs pull-requests: write)', repo: 'acme-corp/agenfk-flows' } };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('pull-requests: write');
    expect(ghPathTried()).toBe(false);
  });

  it('reports a hub server error as 502, without falling back', async () => {
    publishReply = { status: 500, body: { error: 'boom' } };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(502);
    expect(ghPathTried()).toBe(false);
  });

  it('404s an unknown flow before contacting the hub', async () => {
    const res = await agent().post('/registry/flows/publish').send({ flowId: 'no-such-flow' });
    expect(res.status).toBe(404);
    expect(publishCalls).toHaveLength(0);
  });

  // ── review round 1 ───────────────────────────────────────────────────────

  it('does NOT fall back when the hub answers 409 for any reason other than "public registry"', async () => {
    // The hub really sends this one: a private registry with no stored token.
    // Falling back here would publish a private org's flow to the PUBLIC repo.
    publishReply = { status: 409, body: { error: 'no GitHub token is stored for the org registry acme-corp/agenfk-flows', repo: 'acme-corp/agenfk-flows' } };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no GitHub token');
    expect(ghPathTried()).toBe(false);
  });

  it('does NOT fall back on a "public" flag that is not exactly true', async () => {
    publishReply = { status: 409, body: { error: 'x', public: 'true' } };
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(ghPathTried()).toBe(false);
  });

  it('tells the user to upgrade a hub that has no publish route, without falling back', async () => {
    publishReply = { status: 404, nonJson: true };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/upgrade/i);
    expect(ghPathTried()).toBe(false);
  });

  it('refuses a success answer it cannot use, instead of reporting a publish that did not happen', async () => {
    // A proxy's HTML page, or a body with no link: "PR opened" with nothing
    // behind it is a false success.
    for (const reply of [
      { status: 200, nonJson: true },
      { status: 200, body: {} },
      { status: 200, body: { kind: 'pr', url: 'javascript:alert(1)' } },
      { status: 200, body: { kind: 'merged', url: 'https://github.com/x/y/pull/1' } },
      { status: 200, body: { kind: 'pr', url: 'https://github.com.evil.test/x/pull/1' } },
    ] as Reply[]) {
      publishReply = reply;
      const res = await agent().post('/registry/flows/publish').send({ flowId });
      expect(res.status, JSON.stringify(reply)).toBe(502);
      expect(res.body.error).toMatch(/unexpected/i);
    }
    expect(ghPathTried()).toBe(false);
  });

  it('says the hub may still finish when it did not answer in time, rather than calling it unreachable', async () => {
    publishReply = { error: 'The operation was aborted due to timeout', errorName: 'TimeoutError' };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/did not answer/i);
    expect(res.body.error).toMatch(/safe/i);
    expect(ghPathTried()).toBe(false);
  });

  it('sends only the registry fields of each step, not local ids or cosmetics', async () => {
    await agent().post('/registry/flows/publish').send({ flowId });
    for (const step of publishCalls[0].body.flow.steps) {
      expect(Object.keys(step).sort()).toEqual(
        expect.arrayContaining(['name', 'label', 'order']),
      );
      expect(step).not.toHaveProperty('id');
      expect(step).not.toHaveProperty('color');
      expect(step).not.toHaveProperty('icon');
    }
  });

  it('keeps the flow\'s version in step with what the hub published', async () => {
    publishReply = {
      status: 200,
      body: { kind: 'pr', url: 'https://github.com/acme-corp/agenfk-flows/pull/9', repo: 'acme-corp/agenfk-flows', version: '1.0.7' },
    };
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.body.version).toBe('1.0.7');
    const flow = (await agent().get(`/flows/${flowId}`)).body;
    expect(flow.version).toBe('1.0.7');
  });

  // ── CGLAB-372: who "Published by" names ─────────────────────────────────

  /** gh answers `api user --jq .login` with this; anything else is "not installed". */
  const ghAnswers = (stdout: string) => (...a: any[]) => {
    const cb = a[a.length - 1];
    if (a[0] === 'gh' && Array.isArray(a[1]) && a[1].join(' ') === 'api --hostname github.com user --jq .login') cb(null, stdout, '');
    else ghMissing(...a);
  };

  it('credits the GitHub login when gh is signed in (CGLAB-372)', async () => {
    execFile.mockImplementation(ghAnswers('octo-dana\n'));
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls[0].body.publisher).toBe('octo-dana');
    // argv, never a shell string
    const call = execFile.mock.calls.find((c) => c[0] === 'gh');
    // Pinned to github.com: a GH_HOST pointing at GitHub Enterprise would
    // otherwise credit an identity from a different GitHub than the PR's.
    expect(call?.[1]).toEqual(['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
  });

  it('falls back to the OS login when gh is missing or signed out (CGLAB-372)', async () => {
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls[0].body.publisher).toBe(os.userInfo().username);
  });

  it('ignores an answer from gh that is not a GitHub login (CGLAB-372)', async () => {
    execFile.mockImplementation(ghAnswers('You are not logged into any GitHub hosts!\n'));
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls[0].body.publisher).toBe(os.userInfo().username);
  });

  it('does not let a hung gh hold up the publish (CGLAB-372)', async () => {
    execFile.mockImplementation(() => { /* never answers */ });
    const started = Date.now();
    const res = await agent().post('/registry/flows/publish').send({ flowId });
    expect(res.status).toBe(200);
    expect(Date.now() - started, 'the publish waited on gh').toBeLessThan(5000);
    expect(publishCalls[0].body.publisher).toBe(os.userInfo().username);
  }, 10_000);

  it('accepts an Enterprise Managed User login, which carries an underscore (CGLAB-372 review)', async () => {
    execFile.mockImplementation(ghAnswers('dana_acme\n'));
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls[0].body.publisher).toBe('dana_acme');
  });

  it('does not credit the literal "null" jq prints for a missing login (CGLAB-372 review)', async () => {
    execFile.mockImplementation(ghAnswers('null\n'));
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls[0].body.publisher).toBe(os.userInfo().username);
  });

  it('ignores what gh printed when it exited with an error (CGLAB-372 review)', async () => {
    execFile.mockImplementation((...a: any[]) => {
      const cb = a[a.length - 1];
      cb(Object.assign(new Error('Command failed: gh api user'), { code: 1 }), 'octo-dana\n', 'HTTP 401');
    });
    await agent().post('/registry/flows/publish').send({ flowId });
    expect(publishCalls[0].body.publisher).toBe(os.userInfo().username);
  });
});
