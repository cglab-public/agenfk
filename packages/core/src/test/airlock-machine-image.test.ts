/**
 * @vitest-environment node
 *
 * CGLAB-696 task 4: the policy can name the image an Airlock machine is made
 * from (`machineImage`), org-wide and per project (in a project override). Only
 * the policy names it - the hub admin, or the standalone board - never the
 * repository: the image is root in the machine (user decision 2026-10-30). A
 * project's image wins over the org's. Absent means the AgEnFK base image. The
 * value goes to smolvm as an argument, so only an image reference is kept:
 * anything else is dropped by the normaliser and refused by the validator.
 */
import { describe, it, expect } from 'vitest';
import { normalizeAirlockPolicy, airlockPolicyErrors, effectivePolicyFor, isAirlockImageRef } from '../airlock';
import * as core from '../index';

const DIGEST = `sha256:${'a1'.repeat(32)}`;

const VALID = [
  'ghcr.io/cglab-public/agenfk-airlock-base:2.1.0-beta.6',
  'node:22-bookworm-slim',
  'debian',
  'registry.example.com:5000/team/sub/image:v1',
  `ghcr.io/acme/airlock@${DIGEST}`,
  `ghcr.io/acme/airlock:1.2@${DIGEST}`,
  'localhost:5000/airlock_base.x:latest',
];

const INVALID: unknown[] = [
  '-I',
  '--net-backend=passt',
  'ghcr.io/acme/airlock:1 --trust-host-certs',
  'GHCR.io/Acme/Airlock',
  'ghcr.io/acme/airlock:',
  'ghcr.io/acme/airlock@sha256:short',
  'ghcr.io//airlock',
  'ghcr.io/acme/airlock\n',
  'a'.repeat(256),
  `ghcr.io/acme/${'x'.repeat(250)}`,
  42,
  null,
  {},
];

describe('isAirlockImageRef', () => {
  it.each(VALID)('accepts %s', (ref) => {
    expect(isAirlockImageRef(ref)).toBe(true);
  });

  it.each(INVALID.map((v) => [v]))('refuses %j', (ref) => {
    expect(isAirlockImageRef(ref)).toBe(false);
  });

  it('is exported from the core package entry', () => {
    expect(core.isAirlockImageRef('debian')).toBe(true);
  });
});

describe('machineImage in the policy', () => {
  it('is kept by the normaliser when it is an image reference', () => {
    const p = normalizeAirlockPolicy({ mode: 'enforce', machineImage: 'ghcr.io/acme/airlock:1.2' });
    expect(p.machineImage).toBe('ghcr.io/acme/airlock:1.2');
  });

  it('is absent when unset or empty: the policy names no image', () => {
    expect('machineImage' in normalizeAirlockPolicy({ mode: 'enforce' })).toBe(false);
    expect('machineImage' in normalizeAirlockPolicy({ mode: 'enforce', machineImage: '' })).toBe(false);
  });

  it('is dropped by the normaliser when it is anything but an image reference', () => {
    for (const bad of INVALID) {
      expect('machineImage' in normalizeAirlockPolicy({ mode: 'enforce', machineImage: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it('is refused by the validator when it is anything but an image reference, naming the field', () => {
    for (const bad of INVALID) {
      const errors = airlockPolicyErrors({ machineImage: bad });
      expect(errors.length, JSON.stringify(bad)).toBe(1);
      expect(errors[0]).toMatch(/^machineImage/);
    }
  });

  it('passes the validator when it is an image reference, or empty', () => {
    for (const ok of [...VALID, '']) expect(airlockPolicyErrors({ machineImage: ok })).toEqual([]);
  });

  it('is the org\'s in the effective policy of every project, whatever their overrides', () => {
    const policy = normalizeAirlockPolicy({
      mode: 'enforce',
      machineImage: 'ghcr.io/acme/airlock:1.2',
      projects: { 'github.com/acme/app': { hosts: { allow: ['pypi.org'], deny: [] } } },
    });
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/app' }).machineImage).toBe('ghcr.io/acme/airlock:1.2');
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/other' }).machineImage).toBe('ghcr.io/acme/airlock:1.2');
  });

  it('can be set per project by an override, which wins over the org\'s for that project only', () => {
    const policy = normalizeAirlockPolicy({
      mode: 'enforce',
      machineImage: 'ghcr.io/acme/airlock:1.2',
      projects: { 'github.com/acme/app': { machineImage: 'ghcr.io/acme/app-airlock:3' } },
    });
    expect(policy.projects?.['github.com/acme/app']?.machineImage).toBe('ghcr.io/acme/app-airlock:3');
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/app' }).machineImage).toBe('ghcr.io/acme/app-airlock:3');
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/other' }).machineImage).toBe('ghcr.io/acme/airlock:1.2');
  });

  it('a project:<id> override\'s image wins over its repository override\'s', () => {
    const policy = normalizeAirlockPolicy({
      mode: 'enforce',
      projects: { 'github.com/acme/app': { machineImage: 'ghcr.io/acme/repo:1' }, 'project:p1': { machineImage: 'ghcr.io/acme/proj:1' } },
    });
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/app', projectId: 'p1' }).machineImage).toBe('ghcr.io/acme/proj:1');
  });

  it('a project override\'s image that is no image reference is dropped by the normaliser and refused by the validator', () => {
    const raw = { mode: 'enforce', projects: { 'github.com/acme/app': { machineImage: 'x:1 --trust-host-certs', hosts: { allow: ['pypi.org'], deny: [] } } } };
    expect(JSON.stringify(normalizeAirlockPolicy(raw).projects)).not.toContain('trust-host-certs');
    expect(airlockPolicyErrors(raw).join(' ')).toMatch(/projects\["github\.com\/acme\/app"\]\.machineImage/);
  });
});
