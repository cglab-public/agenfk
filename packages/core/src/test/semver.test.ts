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
