import { describe, it, expect } from 'vitest';
import { compareSemver } from '../util/semver';

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('compareSemver', () => {
  it('compares major/minor/patch numerically', () => {
    expect(sign(compareSemver('1.0.0', '0.9.9'))).toBe(1);
    expect(sign(compareSemver('1.0.0', '1.0.1'))).toBe(-1);
    expect(sign(compareSemver('0.10.0', '0.2.0'))).toBe(1);
  });

  it('handles a leading v', () => {
    expect(sign(compareSemver('v1.2.3', '1.2.3'))).toBe(0);
    expect(sign(compareSemver('v0.4.0', 'v0.3.0'))).toBe(1);
  });

  it('ranks releases above their own prereleases', () => {
    expect(sign(compareSemver('1.0.0', '1.0.0-rc.1'))).toBe(1);
    expect(sign(compareSemver('1.0.0-rc.1', '1.0.0'))).toBe(-1);
  });

  it('compares numeric prerelease segments numerically — the regression', () => {
    // The previous implementation localeCompare'd "beta.9" vs "beta.24" and got
    // 9 > 24 because '9' > '2'. Verify we now compare 9 vs 24 numerically.
    expect(sign(compareSemver('0.3.0-beta.24', '0.3.0-beta.9'))).toBe(1);
    expect(sign(compareSemver('0.3.0-beta.10', '0.3.0-beta.3'))).toBe(1);
    expect(sign(compareSemver('0.3.0-beta.23', '0.3.0-beta.24'))).toBe(-1);
  });

  it('sorts a realistic beta sequence newest → oldest correctly', () => {
    const versions = [
      '0.3.0-beta.3', '0.3.0-beta.9', '0.3.0-beta.10', '0.3.0-beta.22',
      '0.3.0-beta.23', '0.3.0-beta.24',
    ];
    const sorted = versions.slice().sort((a, b) => compareSemver(b, a));
    expect(sorted).toEqual([
      '0.3.0-beta.24', '0.3.0-beta.23', '0.3.0-beta.22', '0.3.0-beta.10',
      '0.3.0-beta.9', '0.3.0-beta.3',
    ]);
  });

  it('orders numeric identifiers below alphanumeric ones (semver §11.4.3)', () => {
    expect(sign(compareSemver('1.0.0-alpha', '1.0.0-1'))).toBe(1);
    expect(sign(compareSemver('1.0.0-1', '1.0.0-alpha'))).toBe(-1);
  });

  it('a shorter prerelease list ranks below a longer one with the same prefix', () => {
    expect(sign(compareSemver('1.0.0-alpha.1', '1.0.0-alpha'))).toBe(1);
    expect(sign(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'))).toBe(-1);
  });

  it('falls back to locale compare for malformed inputs', () => {
    expect(sign(compareSemver('not-a-version', 'also-not'))).toBe(sign('not-a-version'.localeCompare('also-not')));
  });
});
