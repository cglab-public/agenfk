/**
 * @vitest-environment node
 *
 * The policy normaliser is a whitelist that defaults to OFF: whatever arrives
 * (an old row, a hub body, a hand-edited file) comes out as a well-formed policy
 * that does nothing it was not told to. The validator is the stricter twin used
 * where a write is refused rather than repaired (server PUT, hub admin PUT, the
 * server's hub sync), and it refuses to let anyone allow-list a metadata host.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizeAirlockPolicy,
  airlockPolicyErrors,
  matchHost,
  DEFAULT_AIRLOCK_POLICY,
  BUILTIN_DENY_HOSTS,
} from '../airlock';
import * as core from '../index';

describe('normalizeAirlockPolicy', () => {
  it('normalize drops unknown keys, defaults off', () => {
    expect(normalizeAirlockPolicy(undefined)).toEqual(DEFAULT_AIRLOCK_POLICY);
    expect(normalizeAirlockPolicy('enforce')).toEqual(DEFAULT_AIRLOCK_POLICY);
    expect(normalizeAirlockPolicy({})).toEqual(DEFAULT_AIRLOCK_POLICY);

    const n = normalizeAirlockPolicy({
      mode: 'enforce',
      extra: 'dropped',
      models: [{ provider: 'p', model: 'm', junk: 1 }, 'not-a-selector', { client: 'nope' }],
      hosts: { allow: ['API.Example.com', 7, '169.254.169.254'], deny: ['bad.example'], other: [] },
      rules: { cloudMutation: 'deny', namespaceEscape: 'maybe', bogus: 'deny' },
      iocHosts: { revision: 'r9', hosts: ['ioc.example', 'not a host'], updatedAt: '2026-10-01T00:00:00Z' },
    });
    expect(n).not.toHaveProperty('extra');
    expect(n.schemaVersion).toBe(1);
    expect(n.mode).toBe('enforce');
    expect(n.models).toEqual([{ provider: 'p', model: 'm' }]);
    expect(n.hosts).toEqual({ allow: ['api.example.com'], deny: ['bad.example'] });
    expect(n.rules).toEqual({ ...DEFAULT_AIRLOCK_POLICY.rules, cloudMutation: 'deny' });
    expect(n.rules).not.toHaveProperty('bogus');
    expect(n.iocHosts).toEqual({ revision: 'r9', hosts: ['ioc.example'], updatedAt: '2026-10-01T00:00:00Z' });
    expect(n.appliesWhenModelUnknown).toBe(true);
  });

  it('an unknown mode falls back to off', () => {
    expect(normalizeAirlockPolicy({ mode: 'ENFORCE!' }).mode).toBe('off');
  });

  it('returns a fresh object each time (the default is never shared)', () => {
    const a = normalizeAirlockPolicy({});
    a.hosts.allow.push('x.example');
    expect(normalizeAirlockPolicy({}).hosts.allow).toEqual([]);
    expect(DEFAULT_AIRLOCK_POLICY.hosts.allow).toEqual([]);
  });

  it('defaults the rules as designed', () => {
    expect(DEFAULT_AIRLOCK_POLICY.rules).toEqual({
      uploadToUnlistedHost: 'deny',
      credentialReadWithNetwork: 'deny',
      namespaceEscape: 'deny',
      cloudMutation: 'needs-human-approval',
    });
  });

  it('a normalised policy has no errors', () => {
    expect(airlockPolicyErrors(normalizeAirlockPolicy({ mode: 'observe', hosts: { allow: ['10.0.0.0/8'] } }))).toEqual([]);
    expect(airlockPolicyErrors(DEFAULT_AIRLOCK_POLICY)).toEqual([]);
  });
});

describe('airlockPolicyErrors', () => {
  const ok = () => JSON.parse(JSON.stringify(DEFAULT_AIRLOCK_POLICY));

  it('errors on allow-listing a built-in host, bad CIDR, bad mode', () => {
    for (const h of BUILTIN_DENY_HOSTS) {
      const p = ok();
      p.hosts.allow = [h];
      expect(airlockPolicyErrors(p).join('\n'), h).toMatch(/built-in/i);
    }
    const covering = ok();
    covering.hosts.allow = ['169.254.0.0/16'];
    expect(airlockPolicyErrors(covering).join('\n')).toMatch(/built-in/i);

    const cidr = ok();
    cidr.hosts.deny = ['10.0.0.0/33'];
    expect(airlockPolicyErrors(cidr).join('\n')).toMatch(/10\.0\.0\.0\/33/);
    const cidr6 = ok();
    cidr6.hosts.deny = ['fd00::/129'];
    expect(airlockPolicyErrors(cidr6).length).toBeGreaterThan(0);
    const cidrIp = ok();
    cidrIp.hosts.deny = ['300.1.1.1/8'];
    expect(airlockPolicyErrors(cidrIp).length).toBeGreaterThan(0);

    const mode = ok();
    mode.mode = 'block';
    expect(airlockPolicyErrors(mode).join('\n')).toMatch(/mode/);
  });

  it('errors on bad shapes', () => {
    expect(airlockPolicyErrors(null).length).toBeGreaterThan(0);
    expect(airlockPolicyErrors([]).length).toBeGreaterThan(0);
    const p = ok();
    p.schemaVersion = 2;
    p.models = [{ client: 'cursor' }];
    p.appliesWhenModelUnknown = 'yes';
    p.rules.cloudMutation = 'maybe';
    p.hosts.allow = ['a b'];
    p.iocHosts.hosts = 'x';
    const errs = airlockPolicyErrors(p).join('\n');
    expect(errs).toMatch(/schemaVersion/);
    expect(errs).toMatch(/client/);
    expect(errs).toMatch(/appliesWhenModelUnknown/);
    expect(errs).toMatch(/cloudMutation/);
    expect(errs).toMatch(/a b/);
    expect(errs).toMatch(/iocHosts/);
  });
});

describe('matchHost', () => {
  it('matches exact, wildcard, IPv4 and IPv6 CIDR', () => {
    expect(matchHost('api.example.com', ['api.example.com'])).toBe(true);
    expect(matchHost('API.EXAMPLE.COM.', ['api.example.com'])).toBe(true);
    expect(matchHost('x.api.example.com', ['api.example.com'])).toBe(false);
    expect(matchHost('a.example.com', ['*.example.com'])).toBe(true);
    expect(matchHost('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(matchHost('example.com', ['*.example.com'])).toBe(false);
    expect(matchHost('badexample.com', ['*.example.com'])).toBe(false);
    expect(matchHost('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(matchHost('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(matchHost('fd00:ec2::254', ['fd00::/8'])).toBe(true);
    expect(matchHost('[fd00:ec2::254]', ['fd00:ec2:0::254'])).toBe(true);
    expect(matchHost('fe80::1', ['fd00::/8'])).toBe(false);
    expect(matchHost('::ffff:10.0.0.1', ['10.0.0.0/8'])).toBe(true);
    expect(matchHost('10.0.0.1', ['example.com', '*.example.com'])).toBe(false);
    expect(matchHost('example.com', ['10.0.0.0/8'])).toBe(false);
    expect(matchHost('anything.example', ['*'])).toBe(true);
    expect(matchHost('', ['*'])).toBe(false);
  });
});

describe('engine boundaries', () => {
  it('engine imports only node builtins', () => {
    const dir = path.join(__dirname, '..', 'airlock');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const specifier = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(specifier)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (spec.startsWith('node:')) continue;
        expect(spec, `${f} imports ${spec}`).toMatch(/^\.\//);
        const resolved = path.resolve(dir, spec);
        expect(path.dirname(resolved), `${f} imports ${spec}`).toBe(dir);
      }
    }
  });

  it('is exported from the core package entry', () => {
    expect(typeof core.evaluateAirlock).toBe('function');
    expect(typeof core.capabilitiesOf).toBe('function');
    expect(typeof core.normalizeAirlockPolicy).toBe('function');
    expect(typeof core.airlockPolicyErrors).toBe('function');
    expect(typeof core.matchHost).toBe('function');
    expect(typeof core.approvalKeyOf).toBe('function');
    expect(core.DEFAULT_AIRLOCK_POLICY.mode).toBe('off');
  });
});
