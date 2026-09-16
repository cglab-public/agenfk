/**
 * @vitest-environment jsdom
 *
 * The UI's copy of the settings shape, pinned to core's.
 *
 * `AppSettingsDto` is a hand-written duplicate of `AppSettings`, and it has to
 * be: `@agenfk/core` compiles to CommonJS, so importing it from the browser
 * bundle either fails the build or ships a black window — the whole story is in
 * `claimState.ts`, which made the same call for the same reason.
 *
 * That file also states the obligation a copy carries: a copy that DRIFTS is
 * worse than either sharing or not. The drift here has a specific and quiet
 * shape. A setting added to core and missed here is one the screen cannot
 * write: `updateSettings({ theNewOne: … })` fails no type check anywhere,
 * because `Partial<AppSettingsDto>` simply has no such key to disagree with —
 * and the server refuses it with a 400 the user sees as "could not save that".
 *
 * So this test imports core, which it can: vitest aliases the package to
 * SOURCE, and nothing here reaches a browser.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_APP_SETTINGS, SOUND_TIMINGS } from '@agenfk/core';
import type { AppSettingsDto, SoundTimingDto } from '../api';

describe('the settings type the UI writes through', () => {
  it('names every setting core defines, and no others', () => {
    // A `satisfies`-style check done at runtime, because the two types cannot
    // be compared structurally without importing core into the bundle.
    const mirror: Record<keyof AppSettingsDto, true> = {
      tmuxByDefault: true,
      attentionAlerts: true,
      attentionSound: true,
      soundTiming: true,
      osNotifications: true,
    };
    expect(Object.keys(mirror).sort()).toEqual(Object.keys(DEFAULT_APP_SETTINGS).sort());
  });

  it('gives every setting the same type core does', () => {
    // The other half of the drift: a boolean here against a string there is
    // accepted by the compiler on this side and refused by the route.
    const sample: AppSettingsDto = {
      tmuxByDefault: false,
      attentionAlerts: true,
      attentionSound: true,
      soundTiming: 'unfocused',
      osNotifications: true,
    };
    for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettingsDto>) {
      expect(typeof sample[key], key).toBe(typeof DEFAULT_APP_SETTINGS[key]);
    }
  });

  it('offers exactly the timings core will accept', () => {
    // The enum is the one place `typeof` cannot catch a mismatch, so a control
    // offering a third option would produce a 400 the user cannot explain.
    const timings: SoundTimingDto[] = ['always', 'unfocused'];
    expect([...timings].sort()).toEqual([...SOUND_TIMINGS].sort());
  });
});
