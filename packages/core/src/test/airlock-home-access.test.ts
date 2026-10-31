/**
 * @vitest-environment node
 *
 * CGLAB-696 (story 525cd331): what of the host's home folder an Airlock session
 * may read and write is a policy decision (`homeAccess`), org-wide only - no
 * project override and no local flag widens it (user decisions 2026-10-31):
 *  - absent: protect-credentials, today's behaviour (the default);
 *  - 'home-read-only': the whole home folder readable;
 *  - 'home-read-write': the whole home folder writable.
 * AgEnFK's own control paths stay protected in every mode (the sandbox spec's job).
 */
import { describe, it, expect } from 'vitest';
import { normalizeAirlockPolicy, airlockPolicyErrors, effectivePolicyFor, AIRLOCK_HOME_ACCESS } from '../airlock';

describe('homeAccess in the policy', () => {
  it('names the three choices, the default first', () => {
    expect(AIRLOCK_HOME_ACCESS).toEqual(['protect-credentials', 'home-read-only', 'home-read-write']);
  });

  it('is absent by default: credentials protected', () => {
    expect(normalizeAirlockPolicy({}).homeAccess).toBeUndefined();
    expect(normalizeAirlockPolicy({ homeAccess: 'protect-credentials' }).homeAccess).toBeUndefined();
  });

  it.each(['home-read-only', 'home-read-write'] as const)('keeps %s', (v) => {
    expect(normalizeAirlockPolicy({ mode: 'enforce', homeAccess: v }).homeAccess).toBe(v);
  });

  it.each([['read-write'], ['HOME-READ-ONLY'], [true], [1], [null], [{}]])('drops %j: an unknown value never opens the home folder', (v) => {
    expect(normalizeAirlockPolicy({ homeAccess: v }).homeAccess).toBeUndefined();
  });

  it('refuses a write with an unknown value, and accepts each of the three', () => {
    expect(airlockPolicyErrors({ homeAccess: 'everything' })).toEqual([
      'homeAccess must be one of protect-credentials, home-read-only, home-read-write',
    ]);
    for (const v of AIRLOCK_HOME_ACCESS) expect(airlockPolicyErrors({ homeAccess: v })).toEqual([]);
  });

  it('is the org\'s alone: a project override cannot carry it', () => {
    expect(airlockPolicyErrors({ projects: { 'github.com/acme/app': { homeAccess: 'home-read-write' } } })).toEqual([
      'projects["github.com/acme/app"].homeAccess: home access is set org-wide only',
    ]);
    const policy = normalizeAirlockPolicy({
      mode: 'enforce',
      projects: { 'github.com/acme/app': { homeAccess: 'home-read-write', rules: { cloudMutation: 'deny' } } },
    });
    expect(policy.projects?.['github.com/acme/app']).toEqual({ rules: { cloudMutation: 'deny' } });
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/app' }).homeAccess).toBeUndefined();
  });

  it('carries the org\'s value into every project\'s effective policy', () => {
    const policy = normalizeAirlockPolicy({ mode: 'enforce', homeAccess: 'home-read-only', projects: { 'github.com/acme/app': { rules: { cloudMutation: 'deny' } } } });
    expect(effectivePolicyFor(policy, { repo: 'github.com/acme/app' }).homeAccess).toBe('home-read-only');
    expect(effectivePolicyFor(policy, { repo: 'github.com/other/x' }).homeAccess).toBe('home-read-only');
  });
});
