import { describe, it, expect } from 'vitest';
// The npx bootstrap (bin/agenfk.js) is dependency-light and cannot import
// @agenfk/core at clone time, so it has its own copy of the comparator in
// bin/version-utils.mjs. This test guards that copy against the prerelease bug
// that left `npx ... --beta` stuck on beta.8.
// @ts-ignore — .mjs has no .d.ts
import { compareSemver } from '../../../../bin/version-utils.mjs';

describe('bin/version-utils compareSemver (npx bootstrap copy)', () => {
  it('orders beta.10 above beta.8 so the downgrade guard does NOT skip the upgrade', () => {
    // Guard logic: compareSemver(remote, local) < 0 means "downgrade, skip".
    // remote=beta.10, local=beta.8 must be > 0 (an upgrade), not < 0.
    expect(compareSemver('1.1.0-beta.10', '1.1.0-beta.8')).toBeGreaterThan(0);
  });

  it('release outranks prerelease and core ordering holds', () => {
    expect(compareSemver('1.1.0', '1.1.0-beta.10')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-beta.8', '1.0.4')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-beta.9', '1.1.0-beta.9')).toBe(0);
  });
});
