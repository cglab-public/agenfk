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
