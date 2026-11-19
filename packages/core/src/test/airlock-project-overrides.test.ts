/**
 * @vitest-environment node
 *
 * PO-1 (c6af1eb0): per-project overrides in the Airlock policy. An override is
 * keyed by its REPOSITORY (the git remote normalised to host/owner/repo, the
 * hub's own notion of a project across installations), or, on a standalone
 * install, by project:<local id>. It may loosen and tighten (user decision
 * 2026-10-28): its allow and deny lists add to the org's, its rules win over
 * the org's. It can never remove an org deny, and never loosen the built-in
 * metadata hosts or the IOC list.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeAirlockPolicy,
  airlockPolicyErrors,
  effectivePolicyFor,
  airlockRepoKey,
  evaluateAirlock,
  DEFAULT_AIRLOCK_POLICY,
  type AirlockPolicy,
} from '../airlock';

const org = (over: Partial<AirlockPolicy> = {}): AirlockPolicy =>
  normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce', hosts: { allow: ['api.github.com'], deny: ['evil.example'] }, ...over });

describe('airlockRepoKey: adversarial input (CodeQL, BUG b9bd4f1e)', () => {
  it('refuses a string longer than any remote at once, however it repeats .git or /', () => {
    for (const s of ['github.com/a/b' + '.git'.repeat(50_000) + 'x', 'github.com/a/b' + '/'.repeat(200_000) + 'x', 'github.com/a/b' + '/.git'.repeat(50_000) + 'x']) {
      const t0 = performance.now();
      airlockRepoKey(s);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });

  it('just under the cap, repetitions are stripped in linear time', () => {
    const t0 = performance.now();
    expect(airlockRepoKey('github.com/a/b' + '.git'.repeat(500))).toBe('github.com/a/b');
    expect(airlockRepoKey('github.com/a/b' + '/'.repeat(2000))).toBe('github.com/a/b');
    airlockRepoKey('github.com/a/b' + '.git'.repeat(500) + 'x');
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('still strips every trailing .git and slash', () => {
    expect(airlockRepoKey('https://github.com/acme/api.git.git//')).toBe('github.com/acme/api');
    expect(airlockRepoKey('acme/api/.git')).toBeNull();
    expect(airlockRepoKey('acme/api.git/')).toBe('github.com/acme/api');
  });
});

describe('airlockRepoKey', () => {
  it('every form of a git remote names the same repository', () => {
    for (const r of [
      'git@github.com:Acme/API.git', 'https://github.com/acme/api', 'https://github.com/acme/api.git', 'ssh://git@github.com/acme/api.git',
      'https://user@github.com/acme/api/', '  git@GitHub.com:acme/api.git\n', 'acme/api', 'github.com/acme/api',
    ]) expect(airlockRepoKey(r), r).toBe('github.com/acme/api');
    expect(airlockRepoKey('git@gitlab.example.com:team/svc.git')).toBe('gitlab.example.com/team/svc');
  });

  it('a local project id is its own key, and junk is none', () => {
    expect(airlockRepoKey('project:1234-abcd')).toBe('project:1234-abcd');
    for (const bad of ['', 'nope', 'a/b/c/d/e', null, undefined, 42]) expect(airlockRepoKey(bad as any), String(bad)).toBeNull();
  });
});

describe('normalizeAirlockPolicy / airlockPolicyErrors: projects', () => {
  it('keeps valid overrides under their canonical key and drops what it does not know', () => {
    const p = normalizeAirlockPolicy({
      mode: 'enforce',
      projects: {
        'git@github.com:Acme/API.git': { hosts: { allow: ['pypi.org', '169.254.169.254'], deny: ['x.example'] }, rules: { cloudMutation: 'off', bogus: 'deny' }, junk: 1 },
        'project:p-1': { rules: { publishThroughAllowedHost: 'deny' } },
        'not a repo': { hosts: { allow: ['a.example'] } },
      },
    });
    expect(Object.keys(p.projects ?? {}).sort()).toEqual(['github.com/acme/api', 'project:p-1']);
    // a metadata host never goes on an allow list, an override's included
    expect(p.projects!['github.com/acme/api']).toEqual({ hosts: { allow: ['pypi.org'], deny: ['x.example'] }, rules: { cloudMutation: 'off' } });
    expect(p.projects!['project:p-1']).toEqual({ rules: { publishThroughAllowedHost: 'deny' } });
  });

  it('a policy without projects has none, and an empty override is dropped', () => {
    expect(normalizeAirlockPolicy({ mode: 'enforce' }).projects).toBeUndefined();
    expect(normalizeAirlockPolicy({ mode: 'enforce', projects: { 'acme/api': {} } }).projects).toBeUndefined();
  });

  it('a write with a bad override is refused, saying where', () => {
    expect(airlockPolicyErrors({ projects: { 'not a repo': { hosts: { allow: [] } } } })).toEqual(expect.arrayContaining([expect.stringMatching(/projects\["not a repo"\].*repository/)]));
    expect(airlockPolicyErrors({ projects: { 'acme/api': { rules: { cloudMutation: 'maybe' } } } })).toEqual(expect.arrayContaining([expect.stringMatching(/projects\["acme\/api"\]\.rules\.cloudMutation/)]));
    expect(airlockPolicyErrors({ projects: { 'acme/api': { hosts: { allow: ['169.254.169.254'] } } } })).toEqual(expect.arrayContaining([expect.stringMatching(/metadata/)]));
    expect(airlockPolicyErrors({ projects: [] })).toEqual(expect.arrayContaining(['projects must be an object']));
    expect(airlockPolicyErrors(normalizeAirlockPolicy({ mode: 'enforce', projects: { 'acme/api': { rules: { cloudMutation: 'deny' } } } }))).toEqual([]);
  });
});

describe('effectivePolicyFor', () => {
  const policy = org({
    projects: {
      'github.com/acme/api': { hosts: { allow: ['pypi.org'], deny: ['api.github.com', 'tracker.example'] }, rules: { cloudMutation: 'off', namespaceEscape: 'needs-human-approval' } },
      'project:local-1': { hosts: { allow: ['localonly.example'] }, rules: { publishThroughAllowedHost: 'deny' } },
    } as any,
  });

  it('no override for the project: the org policy, without the projects', () => {
    const e = effectivePolicyFor(policy, { repo: 'git@github.com:other/x.git', projectId: 'p-9' });
    expect(e.hosts).toEqual(policy.hosts);
    expect(e.rules).toEqual(policy.rules);
    expect(e.projects).toBeUndefined();
  });

  it('the repo\'s override adds its allows and denies, and its rules win (loosen and tighten)', () => {
    const e = effectivePolicyFor(policy, { repo: 'https://github.com/Acme/api.git', projectId: 'p-9' });
    expect(e.hosts.allow).toEqual(['api.github.com', 'pypi.org']);
    expect(e.hosts.deny).toEqual(['evil.example', 'api.github.com', 'tracker.example']);
    expect(e.rules).toMatchObject({ cloudMutation: 'off', namespaceEscape: 'needs-human-approval', uploadToUnlistedHost: 'deny' });
  });

  it('an override cannot remove an org deny: a deny always outranks an allow', () => {
    const p = org({ projects: { 'acme/api': { hosts: { allow: ['evil.example'] } } } as any });
    const e = effectivePolicyFor(p, { repo: 'acme/api' });
    expect(e.hosts.deny).toContain('evil.example');
    expect(evaluateAirlock(e, { client: 'pi', model: { provider: 'x', id: 'y' }, toolName: 'bash', capabilities: [{ kind: 'url', url: 'https://evil.example/' }] }))
      .toMatchObject({ decision: 'deny', rule: 'denied-host' });
  });

  it('the built-in metadata hosts and the IOC list hold, whatever the override says', () => {
    const p = org({ iocHosts: { revision: '1', hosts: ['bad.example'], updatedAt: null }, projects: { 'acme/api': { hosts: { allow: ['bad.example'] }, rules: { uploadToUnlistedHost: 'off' } } } as any });
    const e = effectivePolicyFor(p, { repo: 'acme/api' });
    const call = (url: string) => evaluateAirlock(e, { client: 'pi', model: { provider: 'x', id: 'y' }, toolName: 'fetch', capabilities: [{ kind: 'url', url }] });
    expect(call('http://169.254.169.254/latest/')).toMatchObject({ decision: 'deny', rule: 'builtin-metadata-deny' });
    expect(call('https://bad.example/')).toMatchObject({ decision: 'deny', rule: 'ioc-host' });
  });

  it('a standalone project with no remote takes its project:<id> override; with both, the repo\'s then the project\'s', () => {
    expect(effectivePolicyFor(policy, { repo: null, projectId: 'local-1' }).hosts.allow).toEqual(['api.github.com', 'localonly.example']);
    const both = org({ projects: { 'acme/api': { rules: { cloudMutation: 'off' } }, 'project:p-1': { rules: { cloudMutation: 'deny' } } } as any });
    expect(effectivePolicyFor(both, { repo: 'acme/api', projectId: 'p-1' }).rules.cloudMutation).toBe('deny');
  });

  it('mode, models and the rest are the org\'s: an override cannot switch Airlock off', () => {
    const p = org({ projects: { 'acme/api': { mode: 'off', models: [{ client: 'pi' }] } } as any });
    const e = effectivePolicyFor(p, { repo: 'acme/api' });
    expect(e.mode).toBe('enforce');
    expect(e.models).toEqual(p.models);
  });
});

describe('PO-1 review (Codex gpt-6.1-sol 01a182d1)', () => {
  it('a key is canonical: normalising it again gives itself, however many .git it had', () => {
    for (const r of ['https://git.example/team/api.git.git', 'git@github.com:Acme/API.git', 'acme/api', 'project:p-1', 'ssh://git@git.example:2222/team/api.git']) {
      const k = airlockRepoKey(r)!;
      expect(airlockRepoKey(k), r).toBe(k);
    }
    expect(airlockRepoKey('https://git.example/team/api.git.git')).toBe('git.example/team/api');
  });

  it('effectivePolicyFor picks the same override from a raw remote as from its key', () => {
    const p = org({ projects: { 'https://git.example/team/api.git.git': { hosts: { deny: ['t.example'] } } } as any });
    expect(effectivePolicyFor(p, { repo: 'https://git.example/team/api.git.git' }).hosts.deny).toContain('t.example');
    expect(effectivePolicyFor(p, { repo: airlockRepoKey('https://git.example/team/api.git.git') }).hosts.deny).toContain('t.example');
  });
});

describe('the launch marker carries its project', () => {
  it('signed with the nonce: the agent cannot change it without breaking the marker', async () => {
    const { mintAirlockSessionMarker, verifyAirlockSessionMarker, airlockLaunchNonce, airlockMarkerProject } = await import('../airlock');
    const nonce = airlockLaunchNonce('cd28943c-5216-40b8-8018-24baf306bc62');
    const marker = mintAirlockSessionMarker('key', nonce);
    const verified = verifyAirlockSessionMarker('key', marker)!;
    expect(airlockMarkerProject(verified)).toBe('cd28943c-5216-40b8-8018-24baf306bc62');
    expect(verifyAirlockSessionMarker('key', marker.replace('cd28943c', 'aaaaaaaa'))).toBeNull();
    expect(airlockMarkerProject(verifyAirlockSessionMarker('key', mintAirlockSessionMarker('key', airlockLaunchNonce(null)))!)).toBeNull();
    // an id the marker cannot carry is no project at all, never a different one
    expect(airlockMarkerProject(airlockLaunchNonce('bad_id with spaces'))).toBeNull();
    // a launcher from before PO-1 said nothing about its project: unknown, not "none"
    expect(airlockMarkerProject('0123456789abcdef0123456789abcdef')).toBeUndefined();
    expect(airlockMarkerProject('launch-1')).toBeUndefined();
  });
});

describe('effectivePolicyFor on a policy nobody normalised', () => {
  it('an override\'s allow never carries a metadata host into the result', () => {
    const raw = { ...org(), projects: { 'github.com/acme/api': { hosts: { allow: ['169.254.169.254', 'pypi.org'], deny: [] } } } } as AirlockPolicy;
    expect(effectivePolicyFor(raw, { repo: 'acme/api' }).hosts.allow).toEqual(['api.github.com', 'pypi.org']);
  });
});
