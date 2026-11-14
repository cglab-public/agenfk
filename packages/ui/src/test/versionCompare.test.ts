/**
 * "Is there a newer version", asked in one place.
 *
 * This lived inside `ReleaseReminder.tsx` as a file-local function. The
 * settings screen asks the same question, and the obvious move — write the
 * comparison again next to the new caller — produces two functions that agree
 * until they do not. The visible failure is specific and silly: the reminder
 * rocket lights up in the corner while the settings row two clicks away says
 * "You're up to date".
 *
 * So it moved out rather than being copied, and this file pins the behaviour
 * that was already being relied on — including the pre-release rule, which is
 * the part most likely to be "simplified" by somebody who did not know it was
 * deliberate.
 */
import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../versionCompare';
import { isUpgrade } from '@agenfk/core';

describe('comparing versions', () => {
  it('sees a newer patch, minor and major', () => {
    expect(isNewerVersion('1.1.19', '1.1.18')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.1.18')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.1.18')).toBe(true);
  });

  it('says no for the same version', () => {
    expect(isNewerVersion('1.1.18', '1.1.18')).toBe(false);
  });

  it('says no for an older one', () => {
    // A user on a beta ahead of the last stable release. Offering them a
    // downgrade as an "update" is how somebody loses the fix they installed.
    expect(isNewerVersion('1.1.17', '1.1.18')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.1.18')).toBe(false);
  });

  it('compares numerically, not as text', () => {
    // '10' sorts before '9' as a string, which is the classic way this breaks
    // and the way it breaks silently for a year until the tenth minor.
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('ignores a leading v', () => {
    // Releases are tagged v1.2.0 and package.json says 1.2.0.
    expect(isNewerVersion('v1.2.0', '1.1.18')).toBe(true);
  });

  it('reads the pre-release suffix by semver order (BUG 61bc10b0)', () => {
    // A beta of the version you already run is still not an upgrade, and
    // 1.2.0-beta.1 against 1.1.18 still is: both held before. What changed is
    // that the suffix is no longer DROPPED, which made the stable that
    // graduates a beta read as "same version" - so the board never announced
    // it - and a newer beta read as no update.
    expect(isNewerVersion('1.1.18-beta.6', '1.1.18')).toBe(false);
    expect(isNewerVersion('1.2.0-beta.1', '1.1.18')).toBe(true);
    expect(isNewerVersion('2.0.0', '2.0.0-beta.12')).toBe(true);
    expect(isNewerVersion('2.0.0-beta.13', '2.0.0-beta.12')).toBe(true);
    expect(isNewerVersion('2.0.0-beta.10', '2.0.0-beta.9')).toBe(true); // numeric, not lexical
    expect(isNewerVersion('2.0.0-beta.12', '2.0.0')).toBe(false);
  });

  it('never offers a hub release (hub-v*) as a framework update', () => {
    expect(isNewerVersion('hub-v9.9.9', '2.0.0')).toBe(false);
  });

  it('agrees with core isUpgrade, which the CLI notice and the tier gate use', () => {
    // The board cannot import @agenfk/core at runtime (CommonJS breaks the
    // bundle, see claimState.ts), so versionCompare is a copy - pinned here
    // against the real one, which this test can import.
    const versions = ['1.1.18', '1.1.18-beta.6', '1.2.0-beta.1', '2.0.0-beta.9', '2.0.0-beta.10', '2.0.0-beta.12',
      '2.0.0', 'v2.0.1', '2.1.0-rc.1', '10.0.0', 'hub-v2.0.0', 'nonsense', '',
      // Every prerelease-ordering branch, and the spellings core accepts (review of 61bc10b0).
      '2.0.0-alpha.1', '2.0.0-beta', '2.0.0-beta.1', '2.0.0-rc.1', '2.0.0-1', '2.1.0-beta.5',
      ' 2.0.0 ', 'V2.0.0', '2.0.0+build.1'];
    for (const a of versions) for (const b of versions) {
      expect(isNewerVersion(a, b), `${a} vs ${b}`).toBe(isUpgrade(a, b));
    }
  });

  it('answers no rather than throwing when a version is missing', () => {
    // The release query goes to the network and may never answer. "No update"
    // is the safe reading of "we do not know"; the settings row says the same
    // thing a different way, by declining to claim you are up to date.
    expect(isNewerVersion('', '1.1.18')).toBe(false);
    expect(isNewerVersion('1.2.0', '')).toBe(false);
    expect(isNewerVersion(undefined as unknown as string, '1.1.18')).toBe(false);
  });
});
