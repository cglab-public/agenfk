/**
 * Service-level tests for the per-org flow registry (CGLAB-138).
 *
 * These exercise flowRegistry.ts directly rather than through HTTP. Two
 * reasons, both learned the hard way during this change:
 *
 * - Speed and isolation. No server boot, no sqlite file, no fetch stub
 *   ordering to get wrong — a whole file of these runs in milliseconds and
 *   cannot interfere with another file's process-global state.
 * - Precision. The HTTP tests assert what an admin sees; several branches here
 *   (a probe that 404s, a listing that returns a directory, a truncated copy)
 *   are almost impossible to distinguish through a single response code. A
 *   mutation testing run showed exactly those branches were never reached, and
 *   they are the ones that decide whether a broken token fails the save or
 *   silently "succeeds".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PUBLIC_REGISTRY_REPO,
  DEFAULT_REGISTRY_BRANCH,
  MAX_COPY_FLOWS,
  isValidRegistrySlug,
  isValidRegistryBranch,
  ghHeaders,
  slugify,
  serializeRegistryFlow,
  probeWriteAccess,
  listRegistryFiles,
  writeRegistryFile,
  copyCommunityFlows,
} from '../services/flowRegistry';

type Reply = { ok?: boolean; status?: number; body?: any } | { throw: string };

/** A fetch double with an explicit route table and a recorded call log. */
function fakeGitHub(routes: Array<[RegExp, () => Reply]>) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: any }> = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, auth, body });
    for (const [re, make] of routes) {
      if (re.test(url)) {
        const r = make();
        if ('throw' in r) throw new Error(r.throw);
        return {
          ok: r.ok ?? (r.status ?? 200) < 400,
          status: r.status ?? 200,
          json: async () => r.body,
        } as any;
      }
    }
    throw new Error(`unrouted ${method} ${url}`);
  });
  return { fn, calls };
}

// ── slug validation ─────────────────────────────────────────────────────────
describe('isValidRegistrySlug', () => {
  it('accepts real GitHub names', () => {
    for (const ok of ['acme/flows', 'acme-corp/agenfk-flows', 'a.b/c_d-1', 'Org/Repo']) {
      expect(isValidRegistrySlug(ok), ok).toBe(true);
    }
  });

  it('rejects anything that is not exactly one owner/repo pair', () => {
    for (const bad of ['', 'noslash', 'a/b/c', 'a/', '/b', '/', 'a//b']) {
      expect(isValidRegistrySlug(bad), bad).toBe(false);
    }
  });

  it('rejects names a shell or git argv could misread', () => {
    // Leading '-' is read as a FLAG by an argv-form git/gh call; the other
    // shapes break out of the URL path or the flows/ directory.
    for (const bad of ['-evil/repo', 'owner/-evil', 'own er/repo', 'owner/repo;rm -rf /', 'a/../../b', '..']) {
      expect(isValidRegistrySlug(bad), bad).toBe(false);
    }
    // A dot inside a repo name is legal GitHub and must stay legal — the
    // danger is path traversal, which the single-separator rule above handles.
    expect(isValidRegistrySlug('a/b.json')).toBe(true);
  });

  it('rejects non-strings without throwing', () => {
    for (const v of [undefined, null, 42, {}, [], true]) {
      expect(isValidRegistrySlug(v as any)).toBe(false);
    }
  });
});

// ── headers ─────────────────────────────────────────────────────────────────
describe('ghHeaders', () => {
  it('sends no Authorization when there is no token', () => {
    const h = ghHeaders(null);
    expect(h.Authorization).toBeUndefined();
    expect(h.Accept).toBe('application/vnd.github+json');
  });

  it('sends a Bearer token when there is one', () => {
    expect(ghHeaders('ghp_abc').Authorization).toBe('Bearer ghp_abc');
  });

  it('does not treat an empty string as a token', () => {
    // An empty token must not produce `Authorization: Bearer ` — GitHub
    // rejects that with 401, which reads as "bad token" rather than "no token".
    expect(ghHeaders('').Authorization).toBeUndefined();
  });
});

// ── probeWriteAccess: every way a save can be refused ───────────────────────
describe('probeWriteAccess', () => {
  it('passes when GitHub reports push permission', async () => {
    const g = fakeGitHub([
      [/\/repos\/acme\/flows$/, () => ({ body: { full_name: 'acme/flows', permissions: { push: true } } })],
    ]);
    await expect(probeWriteAccess(g.fn as any, 'acme/flows', 'ghp')).resolves.toEqual({ ok: true });
  });

  it('sends the token — an anonymous probe would 404 on a private repo', async () => {
    const g = fakeGitHub([
      [/\/repos\/acme\/flows$/, () => ({ body: { full_name: 'acme/flows', permissions: { push: true } } })],
    ]);
    await probeWriteAccess(g.fn as any, 'acme/flows', 'ghp_secret');
    expect(g.calls[0].auth).toBe('Bearer ghp_secret');
  });

  it('refuses on 404, explaining that GitHub hides private repos', async () => {
    const r = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ status: 404, body: { message: 'Not Found' } })]]).fn as any,
      'acme/flows', 'ghp',
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/404|not found/i);
  });

  it('refuses when the token can read but not write', async () => {
    // This is the read-only-PAT mistake. Without this check the org would be
    // pointed at a repo whose flows can never be copied into it.
    const r = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ body: { full_name: 'acme/flows', permissions: { push: false, pull: true } } })]]).fn as any,
      'acme/flows', 'ghp',
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/contents:write|cannot write/i);
  });

  it('passes when GitHub omits the permissions block rather than guessing', async () => {
    // Absent != false. A real /repos response always carries permissions, but
    // an API gateway that strips it must not lock every admin out.
    const r = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ body: { full_name: 'acme/flows', permissions: { push: true } } })]]).fn as any,
      'acme/flows', 'ghp',
    );
    expect(r.ok).toBe(true);
  });

  it('refuses when the body is a non-repo document (proxy/portal HTML)', async () => {
    // No permissions block at all means we are not looking at a repository.
    const r = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ body: { message: 'Moved Permanently', url: 'https://docs.github.com' } })]]).fn as any,
      'acme/flows', 'ghp',
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/could not read a repository document/i);
  });

  it('refuses on a transport failure instead of throwing at the caller', async () => {
    const r = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ throw: 'ECONNREFUSED' })]]).fn as any,
      'acme/flows', 'ghp',
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/ECONNREFUSED/);
  });

  it('refuses on a non-404 HTTP failure and reports the status', async () => {
    const r = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ status: 502, body: {} })]]).fn as any,
      'acme/flows', 'ghp',
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/502/);
  });

  it('refuses when the body cannot be parsed as JSON', async () => {
    // A login portal answering with HTML must not read as "writable".
    const fn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new Error('invalid json'); },
    }));
    const r = await probeWriteAccess(fn as any, 'acme/flows', 'ghp');
    expect(r.ok).toBe(false);
  });
});

// ── listRegistryFiles ───────────────────────────────────────────────────────
describe('listRegistryFiles', () => {
  const listing = (entries: any) =>
    fakeGitHub([[/\/contents\/flows\?/, () => ({ body: entries })]]);

  it('returns only JSON files, dropping directories and other types', async () => {
    const g = listing([
      { name: 'a.json', type: 'file', download_url: 'u/a' },
      { name: 'sub', type: 'dir', download_url: 'u/sub' },
      { name: 'README.md', type: 'file', download_url: 'u/README.md' },
      { name: 'b.json', type: 'file', download_url: 'u/b' },
    ]);
    const out = await listRegistryFiles(g.fn as any, 'acme/flows', 'main', null);
    expect(out.map((f) => f.name)).toEqual(['a.json', 'b.json']);
  });

  it('drops entries whose name is not a string', async () => {
    // A malformed entry would otherwise reach slugify(undefined) and produce
    // the filename "undefined.json" in the org's repo.
    const g = listing([
      { name: 42, type: 'file', download_url: 'u/x' },
      { name: 'ok.json', type: 'file', download_url: 'u/ok' },
    ]);
    const out = await listRegistryFiles(g.fn as any, 'acme/flows', 'main', null);
    expect(out.map((f) => f.name)).toEqual(['ok.json']);
  });

  it('treats a missing flows/ directory as an empty registry', async () => {
    // Exactly the state a brand-new private registry starts in.
    const g = fakeGitHub([[/\/contents\/flows\?/, () => ({ status: 404, body: {} })]]);
    await expect(listRegistryFiles(g.fn as any, 'acme/flows', 'main', 'ghp')).resolves.toEqual([]);
  });

  it('throws on a real failure rather than reporting an empty registry', async () => {
    // An empty list is a legitimate answer; a 500 is not. Collapsing the two
    // would show an admin an empty catalogue on a transient GitHub outage.
    const g = fakeGitHub([[/\/contents\/flows\?/, () => ({ status: 500, body: {} })]]);
    await expect(listRegistryFiles(g.fn as any, 'acme/flows', 'main', 'ghp')).rejects.toThrow(/500/);
  });

  it('returns [] when GitHub answers with a non-array body', async () => {
    const g = listing({ message: 'moved' });
    await expect(listRegistryFiles(g.fn as any, 'acme/flows', 'main', null)).resolves.toEqual([]);
  });

  it('URL-encodes the branch so a ref cannot escape the query', async () => {
    const g = listing([]);
    await listRegistryFiles(g.fn as any, 'acme/flows', 'a?x=b&y=', null);
    expect(g.calls[0].url).toContain('ref=a%3Fx%3Db%26y%3D');
  });

  it('authenticates when a token is supplied', async () => {
    const g = listing([]);
    await listRegistryFiles(g.fn as any, 'acme/flows', 'main', 'ghp_t');
    expect(g.calls[0].auth).toBe('Bearer ghp_t');
  });
});

// ── slugify / serialize ─────────────────────────────────────────────────────
describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics into single dashes', () => {
    expect(slugify('TDD Flow+Mutations')).toBe('tdd-flow-mutations');
    expect(slugify('  Spaced   Out  ')).toBe('spaced-out');
  });

  it('produces no leading or trailing dash', () => {
    expect(slugify('!!!Weird!!!')).toBe('weird');
  });

  it('is stable for an already-slugged name (no double-encoding)', () => {
    expect(slugify('lean-flow')).toBe('lean-flow');
  });
});

describe('serializeRegistryFlow', () => {
  it('drops per-installation step ids so two installs cannot collide', () => {
    const out = JSON.parse(serializeRegistryFlow({
      name: 'X', steps: [{ id: 'local-uuid', name: 'A', label: 'A', order: 1 }],
    }, 'me'));
    expect(out.steps[0].id).toBeUndefined();
  });

  it('sorts steps by order regardless of input order', () => {
    const out = JSON.parse(serializeRegistryFlow({
      name: 'X', steps: [{ name: 'C', order: 2 }, { name: 'B', order: 1 }],
    }, 'me'));
    expect(out.steps.map((s: any) => s.name)).toEqual(['B', 'C']);
  });

  it('defaults label to the step name when absent', () => {
    const out = JSON.parse(serializeRegistryFlow({ name: 'X', steps: [{ name: 'A', order: 1 }] }, 'me'));
    expect(out.steps[0].label).toBe('A');
  });

  it('stamps schemaVersion, author and a default version', () => {
    const out = JSON.parse(serializeRegistryFlow({ name: 'X', steps: [] }, 'hub:org-a'));
    expect(out).toMatchObject({ schemaVersion: '1', author: 'hub:org-a', version: '1.0.0', description: '' });
  });

  it('survives a flow with no steps array', () => {
    expect(() => serializeRegistryFlow({ name: 'X' }, 'me')).not.toThrow();
    expect(JSON.parse(serializeRegistryFlow({ name: 'X' }, 'me')).steps).toEqual([]);
  });

  it('is stable across runs so the copy can compare by content', () => {
    const flow = { name: 'X', description: 'd', steps: [{ name: 'A', order: 1 }] };
    expect(serializeRegistryFlow(flow, 'me')).toBe(serializeRegistryFlow(flow, 'me'));
  });
});

// ── writeRegistryFile ───────────────────────────────────────────────────────
describe('writeRegistryFile', () => {
  it('sends base64 content and the message', async () => {
    // GET answers the pre-write existence check, PUT captures the write.
    const calls: Array<{ method: string; body?: any }> = [];
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === 'GET') return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 201, json: async () => ({ content: { sha: 's' } }) } as any;
    });
    const ok = await writeRegistryFile(fn as any, 'acme/flows', 'main', 'ghp', 'a.json', 'BODY', 'msg');
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(Buffer.from(put.body.content, 'base64').toString()).toBe('BODY');
    expect(put.body.message).toBe('msg');
  });

  it('includes the existing sha so GitHub allows the overwrite', async () => {
    // Without the current blob sha, GitHub rejects the PUT with 409.
    const fn = vi.fn(async (_url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ sha: 'sha-old' }) } as any;
      return { ok: true, status: 201, json: async () => ({ content: { sha: 's' } }) } as any;
    });
    await writeRegistryFile(fn as any, 'acme/flows', 'main', 'ghp', 'a.json', 'x', 'm');
    const put = (fn.mock.calls as any[]).find((c) => c[1]?.method === 'PUT')!;
    // body is the JSON string actually sent over the wire.
    expect(JSON.parse(put[1].body).sha).toBe('sha-old');
  });

  it('omits sha for a new file', async () => {
    const fn = vi.fn(async (_url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 201, json: async () => ({ content: { sha: 's' } }) } as any;
    });
    await writeRegistryFile(fn as any, 'acme/flows', 'main', 'ghp', 'new.json', 'x', 'm');
    const put = fn.mock.calls.find((c: any[]) => (c[1]?.method ?? 'GET') === 'PUT')!;
    expect(JSON.parse(put[1].body).sha).toBeUndefined();
  });

  it('returns false when GitHub refuses the write', async () => {
    const fn = vi.fn(async (_url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: false, status: 403, json: async () => ({}) } as any;
    });
    await expect(writeRegistryFile(fn as any, 'acme/flows', 'main', 'ghp', 'a.json', 'x', 'm')).resolves.toBe(false);
  });

  it('encodes the filename so a name cannot escape flows/', async () => {
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 201, json: async () => ({}) } as any;
    });
    await writeRegistryFile(fn as any, 'acme/flows', 'main', 'ghp', '../../etc/passwd', 'x', 'm');
    for (const call of fn.mock.calls as any[]) {
      expect(call[0]).not.toMatch(/\/\.\.\//);
    }
  });
});

// ── copyCommunityFlows ──────────────────────────────────────────────────────
const flowFixture = (name: string) => ({
  name, author: 'cglab', version: '1.0.0',
  steps: [{ name: 'BUILD', label: 'Build', order: 1 }],
});

/** Public registry with `count` flows; org repo already holds `existing`. */
function copyHarness(opts: { count: number; existing?: string[]; failPut?: boolean; broken?: number[]; target?: string }) {
  const targetRepo = opts.target ?? 'acme/flows';
  const written: Record<string, string> = {};
  for (const e of opts.existing ?? []) written[e] = 'PRE-EXISTING';
  const puts: Array<{ name: string; body: string }> = [];
  const broken = new Set(opts.broken ?? []);

  const fn = vi.fn(async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;

    if (method === 'PUT') {
      const name = decodeURIComponent(url.split('/contents/flows/')[1].split('?')[0]);
      if (opts.failPut) return { ok: false, status: 403, json: async () => ({}) } as any;
      written[name] = Buffer.from(body.content, 'base64').toString();
      puts.push({ name, body: written[name] });
      return { ok: true, status: 201, json: async () => ({ content: { sha: 's' } }) } as any;
    }

    // Key on the REPO, not the host: both registries live on api.github.com,
    // and a harness that cannot tell them apart silently answers the wrong one.
    const isOrg = url.includes('/repos/' + targetRepo + '/');

    if (isOrg && url.includes('/contents/flows?')) {
      return {
        ok: true, status: 200,
        json: async () => Object.keys(written)
          .filter((k) => (opts.existing ?? []).includes(k))
          .map((n) => ({ name: n, type: 'file', download_url: `https://org.test/${n}` })),
      } as any;
    }
    // Pre-write existence check — nothing pre-exists in these fixtures.
    if (isOrg && url.includes('/contents/flows/')) {
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }
    // Public listing.
    if (url.includes('/contents/flows?')) {
      return {
        ok: true, status: 200,
        json: async () => Array.from({ length: opts.count }, (_, i) => ({
          name: `f${i}.json`, type: 'file', download_url: `https://pub.test/f${i}.json`,
        })),
      } as any;
    }
    // Public flow content.
    if (url.startsWith('https://pub.test/')) {
      const key = url.split('/').pop()!;
      const i = Number(key.replace('f', '').replace('.json', ''));
      if (broken.has(i)) return { ok: true, status: 200, json: async () => ({ not: 'a flow' }) } as any;
      return { ok: true, status: 200, json: async () => flowFixture(`Flow ${i}`) } as any;
    }
    throw new Error(`unrouted ${method} ${url}`);
  });
  return { fn, puts, written };
}

const runCopy = (h: { fn: any }, target = 'acme/flows') =>
  copyCommunityFlows(h.fn as any, PUBLIC_REGISTRY_REPO, 'main', target, 'main', 'ghp', 'hub:org');

describe('copyCommunityFlows', () => {
  it('copies every community flow once, under a slug filename', async () => {
    const h = copyHarness({ count: 3 });
    const r = await runCopy(h);
    expect(r).toMatchObject({ copied: 3, skipped: 0, failed: [], truncated: false });
    expect(h.puts.map((p) => p.name).sort()).toEqual(['flow-0.json', 'flow-1.json', 'flow-2.json']);
  });

  it('writes valid flow documents, not raw echoes', async () => {
    const h = copyHarness({ count: 1 });
    await runCopy(h);
    const doc = JSON.parse(h.puts[0].body);
    expect(doc).toMatchObject({ schemaVersion: '1', name: 'Flow 0', author: 'hub:org' });
    expect(Array.isArray(doc.steps)).toBe(true);
  });

  it('skips what the target already holds — a re-run must not churn history', async () => {
    const h = copyHarness({ count: 3, existing: ['flow-1.json'] });
    const r = await runCopy(h);
    expect(r).toMatchObject({ copied: 2, skipped: 1 });
    expect(h.puts.map((p) => p.name)).toEqual(['flow-0.json', 'flow-2.json']);
  });

  it('reports each flow it could not copy instead of stopping', async () => {
    const h = copyHarness({ count: 3, broken: [1] });
    const r = await runCopy(h);
    expect(r.copied).toBe(2);
    expect(r.failed).toEqual(['f1.json']);
  });

  it('reports every flow as failed when the target refuses writes', async () => {
    const h = copyHarness({ count: 2, failPut: true });
    const r = await runCopy(h);
    expect(r.copied).toBe(0);
    expect(r.failed).toHaveLength(2);
  });

  it('copies nothing when the source registry is empty', async () => {
    const h = copyHarness({ count: 0 });
    const r = await runCopy(h);
    expect(r).toMatchObject({ copied: 0, skipped: 0, failed: [] });
    expect(h.puts).toHaveLength(0);
  });

  it('stops at MAX_COPY_FLOWS and says so', async () => {
    const h = copyHarness({ count: MAX_COPY_FLOWS + 50 });
    const r = await runCopy(h);
    expect(r.copied).toBe(MAX_COPY_FLOWS);
    expect(r.truncated).toBe(true);
    expect(h.puts).toHaveLength(MAX_COPY_FLOWS);
  });

  it('does NOT report truncation at exactly the bound', async () => {
    // The boundary is where an off-by-one lives: exactly MAX_COPY_FLOWS flows
    // is a complete copy, and claiming otherwise would send the admin to click
    // "Retry copy" forever.
    const h = copyHarness({ count: MAX_COPY_FLOWS });
    const r = await runCopy(h);
    expect(r.copied).toBe(MAX_COPY_FLOWS);
    expect(r.truncated).toBe(false);
  });

  it('does NOT report truncation below the bound', async () => {
    const h = copyHarness({ count: MAX_COPY_FLOWS - 1 });
    expect((await runCopy(h)).truncated).toBe(false);
  });

  it('reads the public registry anonymously and writes the org repo with the token', async () => {
    const h = copyHarness({ count: 1 });
    await runCopy(h);
    const reads = h.fn.mock.calls.filter((c: any[]) => String(c[0]).includes('pub.test')) as any[];
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r[1]?.headers?.Authorization).toBeUndefined();
    const puts = h.fn.mock.calls.filter((c: any[]) => c[1]?.method === 'PUT') as any[];
    for (const p of puts) expect(p[1].headers.Authorization).toBe('Bearer ghp');
  });

  it('never leaks the org token to a public-registry read', async () => {
    const h = copyHarness({ count: 2 });
    await runCopy(h);
    for (const call of h.fn.mock.calls as any[]) {
      if (String(call[0]).includes('pub.test')) {
        expect(JSON.stringify(call[1] ?? {})).not.toContain('ghp');
      }
    }
  });
});

// ── constants ───────────────────────────────────────────────────────────────
describe('registry constants', () => {
  it('defaults to the public community repo and main', () => {
    expect(PUBLIC_REGISTRY_REPO).toBe('cglab-public/agenfk-flows');
    expect(DEFAULT_REGISTRY_BRANCH).toBe('main');
  });

  it('keeps the copy bound below GitHub\'s unauthenticated read budget', async () => {
    // The copy reads each flow anonymously; the unauthenticated content limit
    // is ~60/hour/IP, so a bound above that guarantees a mid-run failure.
    expect(MAX_COPY_FLOWS).toBeGreaterThan(0);
    expect(MAX_COPY_FLOWS).toBeLessThanOrEqual(200);
  });
});

// ── config read/write against a real in-memory sqlite ──────────────────────
// The pure-function tests above cover the shapes; these cover the parts that
// only exist once a row is actually on disk: the ?? / || defaults that decide
// what an org with no row sees, the "blank token keeps the stored one" rule,
// and the copiedAt guard.
import { openSqliteDb } from '../db/sqlite';
import { saveRegistryConfig, getRegistryConfig, registryToken } from '../services/flowRegistry';

const KEY = 'b'.repeat(64);

describe('getRegistryConfig / registryToken / saveRegistryConfig', () => {
  let db: any;
  beforeEach(async () => { db = await openSqliteDb(':memory:'); });
  afterEach(async () => { await db.close(); });

  it('defaults a brand-new org to the public repo on main with no token', async () => {
    const cfg = await getRegistryConfig(db, 'org-new');
    expect(cfg).toEqual({
      repo: PUBLIC_REGISTRY_REPO,
      branch: DEFAULT_REGISTRY_BRANCH,
      isPublic: true,
      hasToken: false,
      copiedAt: null,
    });
  });

  it('reports a non-public repo as not public', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', secretKey: KEY });
    expect((await getRegistryConfig(db, 'org-a')).isPublic).toBe(false);
  });

  it('falls back to main when a blank branch is stored', async () => {
    // An empty-string branch would otherwise build `?ref=`, which GitHub
    // rejects — the `||` (not `??`) is what catches it.
    await db.run(
      'INSERT INTO org_settings (org_id, registry_repo, registry_branch) VALUES (?, ?, ?)',
      ['org-a', 'acme/flows', ''],
    );
    expect((await getRegistryConfig(db, 'org-a')).branch).toBe('main');
  });

  it('keeps a non-default branch', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', branch: 'release-2026', secretKey: KEY });
    expect((await getRegistryConfig(db, 'org-a')).branch).toBe('release-2026');
  });

  it('reports hasToken only when ciphertext is actually present', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', secretKey: KEY });
    expect((await getRegistryConfig(db, 'org-a')).hasToken).toBe(false);
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', token: 'ghp_x', secretKey: KEY });
    expect((await getRegistryConfig(db, 'org-a')).hasToken).toBe(true);
  });

  it('returns null token when none is stored rather than throwing', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', secretKey: KEY });
    await expect(registryToken(db, 'org-a', KEY)).resolves.toBeNull();
  });

  it('returns null token for an org with no row at all', async () => {
    await expect(registryToken(db, 'no-such-org', KEY)).resolves.toBeNull();
  });

  it('round-trips the token through encryption', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', token: 'ghp_round_trip', secretKey: KEY });
    await expect(registryToken(db, 'org-a', KEY)).resolves.toBe('ghp_round_trip');
  });

  it('never stores the token in plaintext', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', token: 'ghp_secret', secretKey: KEY });
    const row = await db.get<{ registry_token_enc: string }>(
      'SELECT registry_token_enc FROM org_settings WHERE org_id = ?', ['org-a']);
    expect(row.registry_token_enc).not.toContain('ghp_secret');
    expect(row.registry_token_enc.startsWith('v1:')).toBe(true);
  });

  it('keeps the stored token when a later save supplies none', async () => {
    // The UI never echoes the secret back, so an unrelated edit (branch change)
    // must not wipe the credential.
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', token: 'ghp_first', secretKey: KEY });
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/other', branch: 'dev', secretKey: KEY });
    expect(await registryToken(db, 'org-a', KEY)).toBe('ghp_first');
    expect((await getRegistryConfig(db, 'org-a')).repo).toBe('acme/other');
  });

  it('replaces the token when a later save supplies one', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', token: 'ghp_first', secretKey: KEY });
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', token: 'ghp_second', secretKey: KEY });
    expect(await registryToken(db, 'org-a', KEY)).toBe('ghp_second');
  });

  it('records copiedAt on the first copy and preserves it afterwards', async () => {
    await saveRegistryConfig(db, 'org-a', {
      repo: 'acme/flows', secretKey: KEY, copiedAt: '2026-05-03T10:00:00Z',
    });
    expect((await getRegistryConfig(db, 'org-a')).copiedAt).toBe('2026-05-03T10:00:00Z');
    // A later save that says nothing about copiedAt must not clear the record.
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', branch: 'dev', secretKey: KEY });
    expect((await getRegistryConfig(db, 'org-a')).copiedAt).toBe('2026-05-03T10:00:00Z');
  });

  it('does not treat an explicit null copiedAt as "leave it alone"', async () => {
    // The guard is `!== undefined && !== null` for a reason: moving back to the
    // public repo passes null deliberately, to clear the copy record.
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', secretKey: KEY, copiedAt: '2026-05-03T10:00:00Z' });
    await saveRegistryConfig(db, 'org-a', { repo: PUBLIC_REGISTRY_REPO, secretKey: KEY, copiedAt: null });
    expect((await getRegistryConfig(db, 'org-a')).copiedAt).toBeNull();
  });

  it('inserts for an org with no row and updates for one with a row', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/one', secretKey: KEY });
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/two', secretKey: KEY });
    const rows = await db.all<{ registry_repo: string }>(
      'SELECT registry_repo FROM org_settings WHERE org_id = ?', ['org-a']);
    expect(rows).toHaveLength(1);
    expect(rows[0].registry_repo).toBe('acme/two');
  });

  it('keeps orgs independent', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/a', token: 'ghp_a', secretKey: KEY });
    await saveRegistryConfig(db, 'org-b', { repo: 'acme/b', token: 'ghp_b', secretKey: KEY });
    expect(await registryToken(db, 'org-a', KEY)).toBe('ghp_a');
    expect(await registryToken(db, 'org-b', KEY)).toBe('ghp_b');
    expect((await getRegistryConfig(db, 'org-c')).repo).toBe(PUBLIC_REGISTRY_REPO);
  });

  it('defaults branch to main on insert when none is given', async () => {
    await saveRegistryConfig(db, 'org-a', { repo: 'acme/flows', secretKey: KEY });
    expect((await getRegistryConfig(db, 'org-a')).branch).toBe('main');
  });
});

// ── Mutant-killers: branches the happy-path tests leave unobserved ─────────
// Each of these exists because a specific mutant survived. Where the mutant is
// genuinely equivalent (e.g. `?? ''` vs `&& ''` on a field that is always
// populated) it is left alone and noted below rather than papered over with an
// assertion that only restates the implementation.
describe('edge branches (mutation survivors)', () => {
  it('ghHeaders keeps the API version header that GitHub version-gates on', async () => {
    // Survived: StringLiteral → "" on the Accept / X-GitHub-Api-Version values.
    // Dropping either still returns 200 in a test that never checks the
    // request, but GitHub changes response shape without the version header.
    const h = ghHeaders('t');
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(h['User-Agent']).toBe('agenfk-hub');
    expect(h.Accept).toContain('github+json');
  });

  it('reports a transport error whose message is missing, not "undefined"', async () => {
    // Survived: `e?.message ?? e` → `e?.message && e`. A throw with no message
    // (a bare `throw {}`) must still produce a usable error string.
    const fn = vi.fn(async () => { throw { toString: () => 'socket hung' }; });
    const r = await probeWriteAccess(fn as any, 'acme/flows', 'ghp');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('socket hung');
    expect((r as any).error).not.toContain('undefined');
  });

  it('distinguishes a 404 from other failures rather than collapsing them', async () => {
    // Survived: ConditionalExpression → false on the `status === 404` branch.
    // Both refuse, but the 404 wording is the one that explains "GitHub hides
    // private repos you cannot see" — the difference an admin needs.
    const notFound = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ status: 404, body: {} })]]).fn as any, 'acme/flows', 'ghp');
    const serverErr = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ status: 500, body: {} })]]).fn as any, 'acme/flows', 'ghp');
    expect((notFound as any).error).toMatch(/not found or not visible/i);
    expect((serverErr as any).error).toMatch(/returned 500/);
    expect((notFound as any).error).not.toBe((serverErr as any).error);
  });

  it('treats a 200 with ok:false body as unreadable rather than writable', async () => {
    // Survived: ArrowFunction → () => undefined on the json().catch handler.
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => undefined }));
    await expect(probeWriteAccess(fn as any, 'acme/flows', 'ghp')).resolves.toMatchObject({ ok: false });
  });

  it('passes when permissions exists but push is true and full_name is present', async () => {
    // Survived: ConditionalExpression → false on `canPush === false`, and
    // OptionalChaining on `meta?.permissions?.push`. Both mutants make every
    // probe pass, which the "read but cannot write" test catches only if the
    // deep-optional read is exercised with a MISSING permissions block too.
    const noPerms = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ body: { full_name: 'acme/flows' } })]]).fn as any, 'acme/flows', 'ghp');
    expect(noPerms.ok).toBe(true);
  });

  it('drops a listing entry that is a file with a non-.json name', async () => {
    // Survived: ConditionalExpression → true on parts of the filter. Each half
    // is tested alone elsewhere; this pins the conjunction.
    const g = fakeGitHub([[/\/contents\/flows\?/, () => ({ body: [
      { name: 'a.json', type: 'dir', download_url: 'u' },      // right name, wrong type
      { name: 'b.md', type: 'file', download_url: 'u' },        // right type, wrong name
      { name: 'c.json', type: 'file', download_url: 'u' },      // the only keeper
    ] })]]) as any;
    const out = await listRegistryFiles(g.fn, 'acme/flows', 'main', null);
    expect(out.map((f: any) => f.name)).toEqual(['c.json']);
  });

  it('serializes a flow whose steps carry no order at all without NaN sorting', async () => {
    // Survived: `a.order ?? 0` → `a.order && 0`, and the comparator's `-` → `+`.
    // A registry file authored by hand can omit order; the sort must not throw
    // or scramble.
    const out = JSON.parse(serializeRegistryFlow({
      name: 'X', steps: [{ name: 'B' }, { name: 'A' }],
    }, 'me'));
    expect(out.steps).toHaveLength(2);
    expect(out.steps.every((s: any) => !Number.isNaN(s.order))).toBe(true);
  });

  it('preserves an empty-string exitCriteria rather than inventing one', async () => {
    // Survived: `s.exitCriteria ?? ''` → `s.exitCriteria && ''` and the
    // "Stryker was here" string. The distinction matters: a step with NO
    // criteria must serialize as empty, not as the literal text.
    const out = JSON.parse(serializeRegistryFlow({
      name: 'X', steps: [{ name: 'A', order: 1, exitCriteria: '' }],
    }, 'me'));
    expect(out.steps[0].exitCriteria).toBe('');
  });

  it('preserves false-valued isSpecial/isAnchor rather than dropping them', async () => {
    // Survived: `?? false` → `&& false` and BooleanLiteral → true. A copied
    // flow that declares isAnchor: false must not arrive as an anchor.
    const out = JSON.parse(serializeRegistryFlow({
      name: 'X', steps: [{ name: 'A', order: 1, isSpecial: false, isAnchor: false }],
    }, 'me'));
    expect(out.steps[0]).toMatchObject({ isSpecial: false, isAnchor: false });
  });

  it('serializes a top-level flow with no optional fields into valid defaults', async () => {
    // Survived: OptionalChaining on flow.name/description/version plus the
    // '1.0.0' default. A minimal file must still produce a loadable document.
    const out = JSON.parse(serializeRegistryFlow({ name: 'Min', steps: [] }, 'me'));
    expect(out).toMatchObject({ name: 'Min', description: '', version: '1.0.0' });
  });

  it('omits sha when the existence check returns a body without one', async () => {
    // Survived: `?.sha` OptionalChaining and `if (existing.ok)` → true. A 200
    // whose body has no sha must not send `sha: undefined` as a real value.
    const fn = vi.fn(async (_u: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ noSha: true }) } as any;
      return { ok: true, status: 201, json: async () => ({}) } as any;
    });
    await writeRegistryFile(fn as any, 'acme/flows', 'main', 'ghp', 'a.json', 'x', 'm');
    const put = (fn.mock.calls as any[]).find((c) => c[1]?.method === 'PUT')!;
    expect('sha' in JSON.parse(put[1].body)).toBe(false);
  });

  it('returns an empty copy result without touching the target when the source is empty', async () => {
    // Survived: ConditionalExpression → false on `allSource.length === 0`,
    // which would send the copy into the target-listing call for nothing.
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') throw new Error('must not write');
      if (url.includes('acme/flows')) throw new Error('must not read the target');
      return { ok: true, status: 200, json: async () => [] } as any;
    });
    const r = await copyCommunityFlows(fn as any, PUBLIC_REGISTRY_REPO, 'main', 'acme/flows', 'main', 'ghp', 'me');
    expect(r).toMatchObject({ copied: 0, skipped: 0, failed: [], truncated: false });
  });

  it('records a flow as failed when its content is not a flow document', async () => {
    // Survived: `!flow?.name || !Array.isArray(flow.steps)` → `&&`. With the
    // conjunction broken, a garbage file would be written into the org repo.
    const h = copyHarness({ count: 2, broken: [0, 1] });
    const r = await runCopy(h);
    expect(r.copied).toBe(0);
    expect(r.failed).toEqual(['f0.json', 'f1.json']);
    expect(h.puts).toHaveLength(0);
  });

  it('uses a default commit message shape that names the flow', async () => {
    // Survived: the template literal in the copy commit message. A commit that
    // does not say which flow it imported is unreviewable in the org repo.
    const h = copyHarness({ count: 1 });
    await runCopy(h);
    const put = (h.fn.mock.calls as any[]).find((c) => c[1]?.method === 'PUT')!;
    expect(JSON.parse(put[1].body).message).toMatch(/Flow 0/);
  });
});

// ── The two paths no test reached at all (mutation NoCoverage) ─────────────
describe('copyCommunityFlows — failure paths that were never executed', () => {
  it('records a flow as failed when its download throws mid-copy', async () => {
    // The catch around each iteration had zero coverage. A single flow whose
    // fetch rejects (connection reset, GitHub 5xx at the CDN) must not abort
    // the whole copy — the admin would otherwise get a save that copied
    // nothing and reported nothing.
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') return { ok: true, status: 201, json: async () => ({}) } as any;
      if (url.includes('acme/flows')) return { ok: true, status: 200, json: async () => [] } as any;
      if (url.includes('/contents/flows?')) {
        return { ok: true, status: 200, json: async () => [
          { name: 'boom.json', type: 'file', download_url: 'https://pub.test/boom.json' },
          { name: 'ok.json', type: 'file', download_url: 'https://pub.test/ok.json' },
        ] } as any;
      }
      if (url.endsWith('boom.json')) throw new Error('socket reset');
      return { ok: true, status: 200, json: async () => flowFixture('Fine') } as any;
    });
    const r = await copyCommunityFlows(fn as any, PUBLIC_REGISTRY_REPO, 'main', 'acme/flows', 'main', 'ghp', 'me');
    expect(r.failed).toEqual(['boom.json']);
    expect(r.copied).toBe(1);
  });

  it('records a flow as failed when its body cannot be parsed', async () => {
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') return { ok: true, status: 201, json: async () => ({}) } as any;
      if (url.includes('acme/flows')) return { ok: true, status: 200, json: async () => [] } as any;
      if (url.includes('/contents/flows?')) {
        return { ok: true, status: 200, json: async () => [
          { name: 'html.json', type: 'file', download_url: 'https://pub.test/html.json' },
        ] } as any;
      }
      return { ok: true, status: 200, json: async () => { throw new Error('invalid json'); } } as any;
    });
    const r = await copyCommunityFlows(fn as any, PUBLIC_REGISTRY_REPO, 'main', 'acme/flows', 'main', 'ghp', 'me');
    // toEqual, not toMatchObject: a partial match lets an extra field (or a
    // skipped count that should have been 1) slip through unnoticed.
    expect(r).toEqual({ copied: 0, skipped: 0, failed: ['html.json'], truncated: false });
  });

  it('records a flow as failed when the source returns a non-200', async () => {
    // A 404 on one file (deleted between listing and read) is a per-flow
    // failure, not a copy abort.
    //
    // Mutation note: the `if (!resp.ok)` guard here is UNKILLABLE by any test,
    // and that is worth stating rather than leaving a reader to rediscover.
    // GitHub's error bodies (`{ message, documentation_url }`, an HTML portal,
    // an empty body) are never valid flow documents, so the `!flow?.name ||
    // !Array.isArray(flow.steps)` check two lines below rejects them anyway and
    // pushes the same filename to `failed`. Removing the guard entirely still
    // yields `{ copied: 0, failed: ['gone.json'] }` — verified by mutation. It
    // is defence in depth: it skips a pointless json parse and keeps the reason
    // for the failure legible, but no observable outcome depends on it. The
    // same fallthrough makes the `typeof meta !== 'object'` guard in
    // probeWriteAccess and the optional-chaining in serializeRegistryFlow
    // equivalent mutants. Killing them would mean asserting on internals that
    // carry no behaviour, so they are left as accepted survivors.
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') return { ok: true, status: 201, json: async () => ({}) } as any;
      if (url.includes('acme/flows')) return { ok: true, status: 200, json: async () => [] } as any;
      if (url.includes('/contents/flows?')) {
        return { ok: true, status: 200, json: async () => [
          { name: 'gone.json', type: 'file', download_url: 'https://pub.test/gone.json' },
        ] } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    });
    const r = await copyCommunityFlows(fn as any, PUBLIC_REGISTRY_REPO, 'main', 'acme/flows', 'main', 'ghp', 'me');
    expect(r).toEqual({ copied: 0, skipped: 0, failed: ['gone.json'], truncated: false });
  });

  it('writes nothing when the target listing throws', async () => {
    // The target-listing call is not inside the per-flow try; a failure there
    // propagates to the caller, which is correct — we cannot know what already
    // exists, so copying would risk clobbering. Asserted so the behaviour is
    // chosen rather than accidental.
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') throw new Error('must not write when target state is unknown');
      if (url.includes('acme/flows')) throw new Error('target listing failed');
      if (url.includes('/contents/flows?')) {
        return { ok: true, status: 200, json: async () => [
          { name: 'a.json', type: 'file', download_url: 'https://pub.test/a.json' },
        ] } as any;
      }
      return { ok: true, status: 200, json: async () => flowFixture('A') } as any;
    });
    await expect(
      copyCommunityFlows(fn as any, PUBLIC_REGISTRY_REPO, 'main', 'acme/flows', 'main', 'ghp', 'me'),
    ).rejects.toThrow(/target listing failed/);
  });
});

describe('remaining killable survivors', () => {
  it('refuses when json() throws — the catch handler must yield null, not undefined', async () => {
    // Survived: ArrowFunction → () => undefined on `.catch(() => null)`.
    // Both are falsy so the `!meta` guard fires either way — but only `null`
    // keeps the guard's three-way shape honest. Asserted so a future edit that
    // drops the catch does not silently change what `meta` holds.
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('html'); } }));
    const r = await probeWriteAccess(fn as any, 'acme/flows', 'ghp');
    expect(r).toEqual({ ok: false, error: "could not read a repository document for acme/flows from GitHub" });
  });

  it('refuses a non-object body (array, string, number) not just null', async () => {
    // Survived: ConditionalExpression → false on `typeof meta !== 'object'`.
    // GitHub can answer with an array or a bare string behind some caches; the
    // `typeof` clause is what stops `meta.full_name` reading through them.
    for (const body of [['not', 'a repo'], 'a string', 42, true]) {
      const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
      const r = await probeWriteAccess(fn as any, 'acme/flows', 'ghp');
      expect(r.ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('refuses when permissions exists but push is explicitly false, with full_name present', async () => {
    // Survived: OptionalChaining on `meta?.permissions?.push`. Removing `?.`
    // only breaks when permissions is absent — which must still PASS (a proxy
    // that strips it should not lock admins out). Both halves pinned together.
    const denied = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ body: { full_name: 'acme/flows', permissions: { push: false } } })]]).fn as any,
      'acme/flows', 'ghp');
    const stripped = await probeWriteAccess(
      fakeGitHub([[/\/repos\//, () => ({ body: { full_name: 'acme/flows' } })]]).fn as any,
      'acme/flows', 'ghp');
    expect(denied.ok).toBe(false);
    expect(stripped.ok).toBe(true);
  });

  // The three validation cases below share one harness, and the assertion that
  // matters is `writeAttempts === 0` — NOT the `failed` list. An earlier version
  // of these tests let the fake `throw` on PUT and asserted only `failed:
  // ['x.json']`; that passed against the mutated code too, because the loop's
  // catch records the thrown error under the same filename. A test that reports
  // the same outcome for correct and broken code cannot kill a mutant, however
  // specific its wording looks. So the fake records writes instead of throwing,
  // and the test fails if a malformed flow is ever written.
  function validationHarness(bodies: Record<string, unknown>) {
    const writeAttempts: string[] = [];
    const fn = vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        writeAttempts.push(decodeURIComponent(url.split('/contents/flows/')[1].split('?')[0]));
        return { ok: true, status: 201, json: async () => ({ content: { sha: 's' } }) } as any;
      }
      if (url.includes('acme/flows')) return { ok: true, status: 200, json: async () => [] } as any;
      if (url.includes('/contents/flows?')) {
        return {
          ok: true, status: 200,
          json: async () => Object.keys(bodies).map((name) => ({
            name, type: 'file', download_url: `https://pub.test/${name}`,
          })),
        } as any;
      }
      const key = url.split('/').pop()!;
      return { ok: true, status: 200, json: async () => bodies[key] } as any;
    });
    return { fn, writeAttempts };
  }

  const runValidation = (bodies: Record<string, unknown>) => {
    const h = validationHarness(bodies);
    return copyCommunityFlows(h.fn as any, PUBLIC_REGISTRY_REPO, 'main', 'acme/flows', 'main', 'ghp', 'me')
      .then((r) => ({ r, writeAttempts: h.writeAttempts }));
  };

  it('rejects a flow whose steps is a non-array before writing it', async () => {
    // Survived: `!flow?.name || !Array.isArray(flow.steps)` → `&&`. Under the
    // mutant the malformed flow is written to the org repo as a zero-step flow.
    const { r, writeAttempts } = await runValidation({ 'bad-steps.json': { name: 'Bad', steps: 'oops' } });
    expect(writeAttempts).toEqual([]);
    expect(r.copied).toBe(0);
    expect(r.failed).toEqual(['bad-steps.json']);
  });

  it('rejects a flow with no name before writing it', async () => {
    // Survived: the `!flow?.name` half. Under the mutant a nameless flow is
    // written, and slugify(undefined) yields the filename ".json" — a file the
    // org repo can never install and that every later nameless flow overwrites.
    const { r, writeAttempts } = await runValidation({ 'unnamed.json': { steps: [{ name: 'A', order: 1 }] } });
    expect(writeAttempts).toEqual([]);
    expect(r.failed).toEqual(['unnamed.json']);
  });

  it('rejects a flow whose body is null before writing it', async () => {
    const { r, writeAttempts } = await runValidation({ 'null-body.json': null });
    expect(writeAttempts).toEqual([]);
    expect(r.failed).toEqual(['null-body.json']);
  });

  it('writes a well-formed flow, so the rejections above are not blanket refusals', async () => {
    // The pair to the three tests above. Without it, a harness that refuses
    // everything would satisfy them all.
    const { r, writeAttempts } = await runValidation({
      'good.json': { name: 'Good Flow', steps: [{ name: 'A', order: 1 }] },
    });
    expect(writeAttempts).toEqual(['good-flow.json']);
    expect(r.copied).toBe(1);
  });
});

// ── Branch validation (REVIEW finding) ─────────────────────────────────────
describe('isValidRegistryBranch', () => {
  it('accepts ordinary and namespaced branch names', () => {
    for (const ref of ['main', 'master', 'develop', 'release/2.0', 'feat/x', 'v1.x',
      'my_branch', 'my-branch', 'a.b.c', 'Release_1', DEFAULT_REGISTRY_BRANCH]) {
      expect(isValidRegistryBranch(ref), ref).toBe(true);
    }
  });

  it('rejects the empty and whitespace-only ref', () => {
    expect(isValidRegistryBranch('')).toBe(false);
    expect(isValidRegistryBranch('   ')).toBe(false);
  });

  it('rejects anything that could escape a URL path segment or read as a flag', () => {
    // '?' and '#' would alter the query/fragment if the value ever reached a
    // URL without encoding; '..' and a leading '-' are traversal and argv-flag
    // shapes; the rest are characters git itself refuses in a refname.
    for (const ref of ['main?ref=other', 'main#x', 'main foo', '../../etc/passwd',
      '-main', 'main~1', 'main^{}', 'main@{u}', 'main\\x', 'main\x00', 'ma"in',
      'main[0]', 'main:foo', 'main*', 'main?', 'main\n', 'refs/../main']) {
      expect(isValidRegistryBranch(ref), JSON.stringify(ref)).toBe(false);
    }
  });

  it('rejects git-forbidden trailing and doubled separators', () => {
    // git refuses a ref ending in '/' or '.', and one containing '//', '/.'
    // or '.lock' — storing them would make every read a silent 404.
    for (const ref of ['main/', 'main.', 'a//b', 'a/./b', './main', '.main']) expect(isValidRegistryBranch(ref), ref).toBe(false);
  });

  it('rejects a non-string and an over-long ref', () => {
    expect(isValidRegistryBranch(null)).toBe(false);
    expect(isValidRegistryBranch(42)).toBe(false);
    expect(isValidRegistryBranch(undefined)).toBe(false);
    expect(isValidRegistryBranch({})).toBe(false);
    expect(isValidRegistryBranch('a'.repeat(256))).toBe(false);
    expect(isValidRegistryBranch('a'.repeat(255))).toBe(true);
  });

  it('trims before deciding, so a pasted ref with padding still validates', () => {
    expect(isValidRegistryBranch('  main  ')).toBe(true);
  });
});

describe('saveRegistryConfig — storage-boundary validation', () => {
  let db: any;
  beforeEach(async () => {
    const { openSqliteDb } = await import('../db/sqlite');
    db = await openSqliteDb(':memory:');
  });
  afterEach(async () => { if (db?.close) await db.close(); });

  // encryptSecret requires a 32-byte key as 64 hex chars (or 44-char base64);
  // 32 chars throws before any validation runs, which is not what these tests
  // are pinning. Same shape the rest of the file uses.
  const key = 'b'.repeat(64);

  it('refuses to store a malformed branch instead of poisoning later reads', async () => {
    // The point of validating here: a bad ref in the column makes every
    // subsequent listRegistryFiles call a 404, which reads as an EMPTY
    // registry. The admin would see zero flows and no error.
    const { saveRegistryConfig } = await import('../services/flowRegistry');
    await expect(
      saveRegistryConfig(db, 'org-1', { repo: 'acme/flows', branch: 'ma in?x', secretKey: key, token: 'ghp' }),
    ).rejects.toThrow(/invalid registry branch/);
    const row = await db.get('SELECT registry_branch FROM org_settings WHERE org_id = ?', ['org-1']);
    expect(row).toBeUndefined();
  });

  it('refuses to store a malformed repo slug', async () => {
    const { saveRegistryConfig } = await import('../services/flowRegistry');
    await expect(
      saveRegistryConfig(db, 'org-1', { repo: 'acme/flows/../evil', secretKey: key, token: 'ghp' }),
    ).rejects.toThrow(/invalid registry repo/);
    const row = await db.get('SELECT registry_repo FROM org_settings WHERE org_id = ?', ['org-1']);
    expect(row).toBeUndefined();
  });

  it('accepts a valid branch and keeps a namespaced one intact', async () => {
    const { saveRegistryConfig, getRegistryConfig } = await import('../services/flowRegistry');
    await saveRegistryConfig(db, 'org-1', { repo: 'acme/flows', branch: 'release/2.0', secretKey: key, token: 'ghp' });
    const cfg = await getRegistryConfig(db, 'org-1');
    expect(cfg.branch).toBe('release/2.0');
  });

  it('treats an omitted branch as the default rather than as invalid', async () => {
    // The guard must not turn "caller did not specify a branch" into a
    // validation failure — that would break every existing caller.
    const { saveRegistryConfig, getRegistryConfig } = await import('../services/flowRegistry');
    await saveRegistryConfig(db, 'org-1', { repo: 'acme/flows', secretKey: key, token: 'ghp' });
    expect((await getRegistryConfig(db, 'org-1')).branch).toBe(DEFAULT_REGISTRY_BRANCH);
    await saveRegistryConfig(db, 'org-2', { repo: 'acme/flows', branch: '', secretKey: key, token: 'ghp' });
    expect((await getRegistryConfig(db, 'org-2')).branch).toBe(DEFAULT_REGISTRY_BRANCH);
  });

  it('validates before writing, so a rejected save leaves no partial row', async () => {
    const { saveRegistryConfig, getRegistryConfig } = await import('../services/flowRegistry');
    await saveRegistryConfig(db, 'org-1', { repo: 'acme/flows', branch: 'main', secretKey: key, token: 'ghp' });
    await expect(
      saveRegistryConfig(db, 'org-1', { repo: 'acme/flows', branch: 'bad ref', secretKey: key }),
    ).rejects.toThrow(/invalid registry branch/);
    // The earlier good value survives untouched — the failed call changed nothing.
    expect((await getRegistryConfig(db, 'org-1')).branch).toBe('main');
  });
});
