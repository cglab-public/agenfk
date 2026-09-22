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

  it('ignores the pre-release suffix', () => {
    // Deliberate, and inherited. A beta of the version you already run is not
    // an upgrade to offer, and 1.2.0-beta.1 against 1.1.18 is.
    expect(isNewerVersion('1.1.18-beta.6', '1.1.18')).toBe(false);
    expect(isNewerVersion('1.2.0-beta.1', '1.1.18')).toBe(true);
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
