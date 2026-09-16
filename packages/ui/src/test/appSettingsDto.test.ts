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
 * worse than either sharing or not. The drift matters in ONE direction, and
 * this file is arranged around that fact.
 *
 * **Core gains a setting, the UI type does not.** Quiet and expensive. The
 * screen cannot write the new setting: `updateSettings({ theNewOne: … })` fails
 * no type check anywhere, because `Partial<AppSettingsDto>` has no such key to
 * disagree with — and the server then refuses it with a 400 the user reads as
 * "could not save that". Nothing in the compiler notices, so a RUNTIME check
 * has to.
 *
 * **The UI type gains one core does not.** Loud and immediate: `SAMPLE` below
 * is an object literal annotated as `AppSettingsDto`, so a key that leaves the
 * interface makes it an excess-property error and the build stops. No runtime
 * assertion is needed, and one written here would only duplicate the compiler.
 *
 * So the sample is the single source for BOTH checks: the compiler polices its
 * shape, and the assertions police it against core's keys. Listing the keys
 * again in an assertion would make them a third spelling, free to agree with
 * neither.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_APP_SETTINGS, SOUND_TIMINGS } from '@agenfk/core';
import type { AppSettingsDto, SoundTimingDto } from '../api';

/**
 * One value of every setting the UI believes exists.
 *
 * Annotated, not inferred. The annotation is what makes a key removed from
 * `AppSettingsDto` a compile error here rather than a silent pass.
 */
const SAMPLE: AppSettingsDto = {
  tmuxByDefault: false,
  attentionAlerts: true,
  attentionSound: true,
  soundTiming: 'unfocused',
  osNotifications: true,
};

describe('the settings type the UI writes through', () => {
  it('knows about every setting core defines', () => {
    // THE assertion. A setting added to core and forgotten here shows up as a
    // missing key, at runtime, in this test — which is the only place it can
    // show up at all.
    const missing = Object.keys(DEFAULT_APP_SETTINGS).filter(k => !(k in SAMPLE));
    expect(missing, 'core has settings the UI type cannot write').toEqual([]);
  });

  it('knows about no settings core does not', () => {
    // The mirror. The compiler catches this first, through SAMPLE's
    // annotation; the assertion is here so the failure names the key rather
    // than pointing at an object literal.
    const extra = Object.keys(SAMPLE).filter(k => !(k in DEFAULT_APP_SETTINGS));
    expect(extra, 'the UI type has settings the server will refuse').toEqual([]);
  });

  it('gives every setting the same type core does', () => {
    // The other half of the drift: a boolean here against a string there is
    // accepted by the compiler on this side and refused by the route.
    for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettingsDto>) {
      expect(typeof SAMPLE[key], key).toBe(typeof DEFAULT_APP_SETTINGS[key]);
    }
  });

  it('offers exactly the timings core will accept', () => {
    // The enum is the one place `typeof` cannot catch a mismatch, so a control
    // offering a third option would produce a 400 the user cannot explain.
    const timings: SoundTimingDto[] = ['always', 'unfocused'];
    expect([...timings].sort()).toEqual([...SOUND_TIMINGS].sort());
  });
});
