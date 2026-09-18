/**
 * The shape of the installation's settings, and the one thing `typeof` cannot
 * check.
 *
 * Every store in this repo validates a setting the same way: compare
 * `typeof value` against `typeof DEFAULT_APP_SETTINGS[key]`. That is exactly
 * right for a boolean and completely blind for an enum — 'always' and
 * 'whenever-i-feel-like-it' are both strings, so the second one is stored,
 * read back, and then falls through every `=== 'always'` comparison in the UI
 * to behave as whatever the last else-branch happens to be.
 *
 * So the set of legal values lives beside the defaults rather than in the
 * server route, because the server is not the only reader: storage-sqlite
 * rebuilds settings from rows on every read and would otherwise hand back a
 * value the route would have refused.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  SOUND_TIMINGS,
  isLegalSettingValue,
  type AppSettings,
} from '../types';

describe('what the installation stores', () => {
  it('knows whether to alert when an agent is waiting for a person', () => {
    // The whole reason the notifications block exists. Without it the user
    // finds out an agent has been blocked for twenty minutes by going to look.
    expect(typeof DEFAULT_APP_SETTINGS.attentionAlerts).toBe('boolean');
  });

  it('keeps sound, timing and OS banners as separate choices', () => {
    // Three different costs. A sound is intrusive in a shared office, a banner
    // is intrusive in a screen share, and someone who wants one rarely wants
    // all three — collapsing them into one switch means the only way to stop
    // the sound is to stop being told at all.
    expect(typeof DEFAULT_APP_SETTINGS.attentionSound).toBe('boolean');
    expect(typeof DEFAULT_APP_SETTINGS.osNotifications).toBe('boolean');
    expect(SOUND_TIMINGS).toContain(DEFAULT_APP_SETTINGS.soundTiming);
  });

  it('defaults the sound to the unfocused window only', () => {
    // Beeping at somebody who is already looking at the thing that beeped is
    // noise with no information in it, and noise with no information is what
    // trains a user to turn the whole feature off.
    expect(DEFAULT_APP_SETTINGS.soundTiming).toBe('unfocused');
  });

  it('leaves tmux exactly where it was', () => {
    // The default is a promise: every install that predates this card worked
    // with tmux off, and adding settings around it must not move it.
    expect(DEFAULT_APP_SETTINGS.tmuxByDefault).toBe(false);
  });

  it('does not hold the custom sound path', () => {
    // It reaches the filesystem, and this store is written through an
    // unauthenticated local HTTP route. It lives in the desktop's own prefs,
    // set only by a main-process file dialog — the same line this repo already
    // draws for autoApprove.
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('customSoundPath');
  });
});

describe('a setting with a fixed set of legal values', () => {
  it('accepts the values it documents', () => {
    for (const timing of SOUND_TIMINGS) {
      expect(isLegalSettingValue('soundTiming', timing)).toBe(true);
    }
  });

  it('refuses a string that is not one of them', () => {
    // THE test. `typeof 'nonsense' === typeof 'unfocused'`, so every existing
    // guard in this repo waves it through.
    expect(isLegalSettingValue('soundTiming', 'nonsense')).toBe(false);
  });

  it('refuses the wrong type for a boolean setting too', () => {
    // One predicate for every key, so a caller never has to remember which
    // settings have an enum and which only have a type.
    expect(isLegalSettingValue('attentionAlerts', 'true')).toBe(false);
    expect(isLegalSettingValue('attentionAlerts', 1)).toBe(false);
    expect(isLegalSettingValue('attentionAlerts', true)).toBe(true);
  });

  it('refuses a key that is not a setting at all', () => {
    // Callers pass keys read off a request body. Answering `true` for an
    // unknown key would make this predicate the hole rather than the guard.
    expect(isLegalSettingValue('autoApproveByDefault' as keyof AppSettings, true)).toBe(false);
  });

  it('refuses a key inherited from Object.prototype', () => {
    // `'constructor' in DEFAULT_APP_SETTINGS` is true, and a naive `in` check
    // would treat it as a known setting. The keys come from a JSON body.
    expect(isLegalSettingValue('constructor' as keyof AppSettings, true)).toBe(false);
    expect(isLegalSettingValue('__proto__' as keyof AppSettings, true)).toBe(false);
  });
});
