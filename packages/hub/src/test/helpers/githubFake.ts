import { vi } from 'vitest';

/**
 * The GitHub API the hub's flow registry talks to, faked for tests (moved here
 * from admin-flow-registry-config.test.ts so the admin CLI's spec, CGLAB-702,
 * drives the same fake). The hub calls the global fetch: stub it with
 * `vi.stubGlobal('fetch', githubFake(...).fn)`.
 */
export const PUBLIC_REPO = 'cglab-public/agenfk-flows';
export const ORG_REPO = 'acme-corp/agenfk-flows';


/** Two community flows, as the public registry serves them. */
export const COMMUNITY_FLOWS = [
  { name: 'TDD Flow', author: 'cglab', version: '1.0.0', steps: [
    { name: 'DISCOVERY', label: 'Discovery', order: 1, exitCriteria: 'x' },
    { name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ] },
  { name: 'Lean Flow', author: 'cglab', version: '2.1.0', steps: [
    { name: 'BUILD', label: 'Build', order: 1 },
  ] },
];

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * A GitHub API fake. Records every call so tests can assert exactly what the
 * hub sent — including that the token rides along on READS, which is the whole
 * reason Option B (hub-stored token) was chosen over a laptop `gh` token:
 * anonymous reads 404 on a private repo.
 */
export function githubFake(opts: {
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

