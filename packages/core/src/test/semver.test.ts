import { describe, it, expect } from 'vitest';
import { compareSemver, isUpgrade } from '../semver';

describe('compareSemver — numeric prerelease ordering', () => {
  it('orders beta.10 ABOVE beta.8 (numeric, not lexical) — the npx --beta bug', () => {
    expect(compareSemver('1.1.0-beta.10', '1.1.0-beta.8')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-beta.8', '1.1.0-beta.10')).toBeLessThan(0);
  });

  it('a release outranks its prerelease', () => {
    expect(compareSemver('1.1.0', '1.1.0-beta.10')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-rc.1', '1.1.0')).toBeLessThan(0);
  });

  it('compares core major.minor.patch', () => {
    expect(compareSemver('1.1.0-beta.8', '1.0.4')).toBeGreaterThan(0); // 1.1.0 > 1.0.4
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.5', '1.0.4')).toBeGreaterThan(0);
  });

  it('numeric prerelease identifiers beat alphanumeric and shorter sorts lower', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-beta')).toBeLessThan(0);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0); // numeric < alphanumeric
  });

  it('equal versions compare to 0', () => {
    expect(compareSemver('1.1.0-beta.9', '1.1.0-beta.9')).toBe(0);
    expect(compareSemver('1.1.0', '1.1.0')).toBe(0);
  });

  it('tolerates a leading v', () => {
    expect(compareSemver('v1.1.0-beta.10', 'v1.1.0-beta.8')).toBeGreaterThan(0);
  });
});

describe('isUpgrade — true only when candidate is strictly newer', () => {
  it('beta.10 over beta.8 is an upgrade', () => {
    expect(isUpgrade('1.1.0-beta.10', '1.1.0-beta.8')).toBe(true);
  });

  it('an older stable is NOT an upgrade over a newer prerelease (the nag bug)', () => {
    // checkUpgradeTier must not nag "v1.0.4 available" when on 1.1.0-beta.8.
    expect(isUpgrade('1.0.4', '1.1.0-beta.8')).toBe(false);
  });

  it('same version is not an upgrade', () => {
    expect(isUpgrade('1.1.0-beta.9', '1.1.0-beta.9')).toBe(false);
  });
});

// BUG b233143b — compareSemver falls back to localeCompare when a side will not
// parse, and 'h' sorts above '1'. A hub release tag (hub-v*, the Docker image
// line) therefore compared as NEWER than every real version, and isUpgrade()
// answered true. That is not a cosmetic nag: the upgrade tier gate trusts this
// answer, and a `mandatory` tier calls process.exit(1) on every CLI invocation.
describe('isUpgrade — an unparseable version is never an upgrade', () => {
  it('a hub tag outranks a real version under compareSemver, and must still not be an upgrade', () => {
    // Pinning both halves: the ordering fallback is real (and kept for callers
    // that only need a sort), so the guard has to live in isUpgrade.
    expect(compareSemver('hub-v1.1.19-beta.1', '1.1.18')).toBeGreaterThan(0);
    expect(isUpgrade('hub-v1.1.19-beta.1', '1.1.18')).toBe(false);
  });

  it('an unparseable CURRENT version does not make every release an upgrade', () => {
    expect(isUpgrade('1.2.0', 'nightly-master')).toBe(false);
  });

  it('real versions are unaffected', () => {
    expect(isUpgrade('1.1.19', '1.1.18')).toBe(true);
    expect(isUpgrade('1.1.19-beta.2', '1.1.19-beta.1')).toBe(true);
    expect(isUpgrade('1.1.18', '1.1.19')).toBe(false);
    expect(isUpgrade('1.1.19-beta.1', '1.1.19')).toBe(false);
  });

  it('compareSemver keeps its string fallback for ordering callers', () => {
    expect(compareSemver('hub-v1.0.0', '1.1.18')).not.toBe(0);
  });
});
