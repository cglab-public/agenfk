import { describe, it, expect, vi, afterEach } from 'vitest';
import { publishFlowPullRequest, serializeRegistryFlow } from '../services/flowRegistry';

/**
 * CGLAB-385 (S9-T1) — the hub's registry file keeps a flow's step roles and
 * checks, and a publish without them (from an older agenfk, which strips the
 * fields it does not know) never replaces a registry flow that has them.
 */
const REPO = 'acme/flows';
const BASE = 'b'.repeat(40);
const rich = { name: 'Org TDD', version: '1.0.0', steps: [{ name: 'TODO', order: 0, isAnchor: true }, { name: 'SPECS', order: 1, role: 'test-authoring', checks: [{ id: 'jira-key-valid' }] }] };
const bare = { name: 'Org TDD', version: '1.0.0', steps: [{ name: 'TODO', order: 0, isAnchor: true }, { name: 'SPECS', order: 1 }] };

function gh(baseFile: string | undefined) {
  const writes: string[] = [];
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fn = vi.fn(async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const p = decodeURIComponent(new URL(url).pathname);
    if (method !== 'GET') writes.push(`${method} ${p}`);
    if (method === 'GET' && p.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: BASE } });
    if (method === 'GET' && p.includes('/git/ref/heads/flow/')) return res(404, {});
    if (method === 'GET' && p.includes('/contents/flows/')) return baseFile === undefined ? res(404, {}) : res(200, { sha: 'f'.repeat(40), content: Buffer.from(baseFile).toString('base64') });
    if (method === 'POST' && p.endsWith('/git/refs')) return res(201, {});
    if (method === 'PUT') return res(201, {});
    if (method === 'POST' && p.endsWith('/pulls')) return res(201, { number: 1, html_url: `https://github.com/${REPO}/pull/1` });
    if (method === 'DELETE') return res(204, {});
    throw new Error(`unexpected ${method} ${p}`);
  });
  return { fn, writes };
}
const publish = (fetchImpl: any, flow: any) => publishFlowPullRequest(fetchImpl, { repo: REPO, branch: 'main', token: 't', flow, publisher: 'me', installationId: null });
afterEach(() => vi.restoreAllMocks());

describe('registry file keeps the step contract', () => {
  it('serializeRegistryFlow carries role and checks', () => {
    const out = JSON.parse(serializeRegistryFlow(rich, 'me'));
    expect(out.steps[1]).toMatchObject({ role: 'test-authoring', checks: [{ id: 'jira-key-valid' }] });
    expect(out.steps[0].role).toBeUndefined();
  });
});

describe('a stripped publish', () => {
  it('is refused when the registry copy has step roles/checks it lacks, and writes nothing', async () => {
    const g = gh(serializeRegistryFlow(rich, 'someone'));
    const r = await publish(g.fn, bare);
    expect(r.kind).toBe('error');
    expect((r as any).status).toBe(409);
    expect((r as any).error).toMatch(/roles|checks/i);
    expect((r as any).error).toMatch(/upgrade/i);
    expect(g.writes).toEqual([]);
  });

  it('goes through when the registry copy has no contract either', async () => {
    const g = gh(serializeRegistryFlow({ ...bare, steps: [...bare.steps, { name: 'MORE', order: 2 }] }, 'someone'));
    expect((await publish(g.fn, bare)).kind).toBe('pr');
  });

  it('goes through when it carries a contract of its own', async () => {
    const g = gh(serializeRegistryFlow(rich, 'someone'));
    expect((await publish(g.fn, { ...rich, steps: [...rich.steps, { name: 'MORE', order: 2, role: 'review' }] })).kind).toBe('pr');
  });
});
