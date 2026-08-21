import { describe, it, expect } from 'vitest';
import { installationDisplayName } from '../pages/installationDisplayName';

interface ApiKeyRow {
  installationId: string | null;
  label: string | null;
  gitName: string | null;
  gitEmail: string | null;
  osUser?: string | null;
  revokedAt?: string | null;
}

const make = (overrides: Partial<ApiKeyRow>): ApiKeyRow => ({
  installationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  label: null, gitName: null, gitEmail: null, osUser: null, revokedAt: null,
  ...overrides,
});

describe('installationDisplayName', () => {
  it('returns the truncated GUID alone when no api-key match is known', () => {
    const out = installationDisplayName([], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toBe('aaaaaaaa…');
  });

  it('uses the api-key label when present', () => {
    const keys = [make({ label: 'daniel-laptop' })];
    const out = installationDisplayName(keys, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toBe('daniel-laptop · aaaaaaaa…');
  });

  it('falls back to gitName + gitEmail when no label', () => {
    const keys = [make({ gitName: 'Daniel P', gitEmail: 'danielp@cglab.com' })];
    const out = installationDisplayName(keys, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toBe('Daniel P <danielp@cglab.com> · aaaaaaaa…');
  });

  it('falls back to gitEmail alone when no name', () => {
    const keys = [make({ gitEmail: 'danielp@cglab.com' })];
    const out = installationDisplayName(keys, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toBe('danielp@cglab.com · aaaaaaaa…');
  });

  it('falls back to osUser when nothing else is set', () => {
    const keys = [make({ osUser: 'daniel' })];
    const out = installationDisplayName(keys, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toBe('daniel · aaaaaaaa…');
  });

  it('skips revoked api-keys when more than one row binds the same installation', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const keys = [
      make({ installationId: id, label: 'old-revoked', revokedAt: '2026-04-01T00:00:00Z' }),
      make({ installationId: id, label: 'current' }),
    ];
    const out = installationDisplayName(keys, id);
    expect(out).toBe('current · aaaaaaaa…');
  });
});

// Live identity must win over the frozen api_key label (task 8b857d4f).
//
// api_keys.label is a snapshot taken when the key was issued and is never
// refreshed. Observed in production: two installs that had no git email at
// invite-redeem time were labelled 'invite:<osuser>' and still showed that on
// the fleet board months later, while the Installations tab — which reads the
// installations row that ingest refreshes from every event — showed their real
// addresses.
describe('installationDisplayName with live installation identity', () => {
  const staleKey = [{
    installationId: 'inst-1',
    label: 'invite:jonatansporn',
    gitName: null,
    gitEmail: null,
    osUser: null,
  }];

  it('prefers the live installation identity over a stale label', () => {
    const out = installationDisplayName(staleKey, 'inst-1', {
      gitName: 'Jonatan Sporn', gitEmail: 'jonatan.sporn@cglab.com', osUser: 'jonatansporn',
    });

    expect(out).toContain('jonatan.sporn@cglab.com');
    expect(out).not.toContain('invite:');
  });

  it('labels an install that has no api_key row at all', () => {
    // The device-code flow used to issue unbound keys, so the board showed a
    // bare GUID even though the hub knew exactly who it was.
    const out = installationDisplayName([], 'inst-2', {
      gitName: 'guilhermecarlossiqueira', gitEmail: null, osUser: 'gcsiqueira',
    });

    expect(out).toContain('guilhermecarlossiqueira');
  });

  it('falls back to os user when the installation has neither name nor email', () => {
    const out = installationDisplayName([], 'inst-3', { gitName: null, gitEmail: null, osUser: 'someuser' });
    expect(out).toContain('someuser');
  });

  it('falls back to the api_key label when the installation row has no identity', () => {
    const out = installationDisplayName(staleKey, 'inst-1', { gitName: null, gitEmail: null, osUser: null });
    expect(out).toContain('invite:jonatansporn');
  });

  it('falls back to the api_key label when no installation row is supplied', () => {
    // Callers that have not been updated keep working.
    expect(installationDisplayName(staleKey, 'inst-1')).toContain('invite:jonatansporn');
  });

  it('still shows the bare GUID when nothing at all is known', () => {
    expect(installationDisplayName([], 'abcdef1234')).toBe('abcdef12…');
  });

  it('keeps the GUID suffix so rows stay identifiable', () => {
    const out = installationDisplayName([], 'inst-2abc', { gitName: null, gitEmail: 'x@y.com', osUser: null });
    expect(out).toBe('x@y.com · inst-2ab…');
  });
});
