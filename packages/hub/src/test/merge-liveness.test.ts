// The shared merge-liveness predicate and alias resolution (CGLAB-72).
//
// Two defects motivated this module, and both were the same missing question.
// The suggestions endpoint and the merge guard each asked "did an installation
// that EVER produced this key keep a live api_key?" — never "could that
// installation still produce it?". So a machine that has since acquired a git
// email, and can no longer derive its old osuser: key at all, blocked a merge
// that was already safe; and the guard's own osUser branch compared a BARE
// username against keys that are namespaced, so it matched nothing and let
// through the one merge it existed to stop.
//
// The predicate below is the answer to the right question, and both call sites
// now share it: an installation blocks a merge only if it currently derives the
// source key, holds a live key, and has actually been seen lately.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIVE_INSTALL_WINDOW_HOURS,
  liveInstallWindowMs,
  derivedUserKeyForInstallation,
  isWithinWindow,
} from '../util/mergeLiveness';
import { resolveAliasKey } from '../util/userKeyAlias';

describe('derivedUserKeyForInstallation', () => {
  // This must track userKeyFor exactly. When it drifts, the guard silently
  // stops matching the keys ingest actually writes — which is defect #2.
  it('prefers the git email, lowercased, as userKeyFor does', () => {
    expect(derivedUserKeyForInstallation({
      id: 'inst-1', os_user: 'gcs', git_email: 'Guilherme@CGLab.com', last_seen: '2026-08-20T00:00:00Z',
    })).toBe('guilherme@cglab.com');
  });

  it('falls back to the installation-namespaced osUser when there is no git email', () => {
    expect(derivedUserKeyForInstallation({
      id: 'd13762b1-aaaa-bbbb-cccc-ddddeeeeffff', os_user: 'gcs', git_email: null, last_seen: '2026-08-20T00:00:00Z',
    })).toBe('osuser:gcs@d13762b1');
  });

  it('treats an empty git email as absent, not as an identity', () => {
    expect(derivedUserKeyForInstallation({
      id: 'inst-2abc3def', os_user: 'dev', git_email: '', last_seen: '2026-08-20T00:00:00Z',
    })).toBe('osuser:dev@2abc3def');
  });

  it('keeps the osUser case, because Windows accounts are named that way', () => {
    expect(derivedUserKeyForInstallation({
      id: 'inst-99887766', os_user: 'DPolistchuck', git_email: null, last_seen: '2026-08-20T00:00:00Z',
    })).toBe('osuser:DPolistchuck@99887766');
  });

  it('never returns a bare username, so the old guard comparison cannot match', () => {
    const key = derivedUserKeyForInstallation({
      id: 'inst-12345678', os_user: 'ubuntu', git_email: null, last_seen: '2026-08-20T00:00:00Z',
    });
    expect(key).not.toBe('ubuntu');
    expect(key.startsWith('osuser:')).toBe(true);
  });
});

describe('isWithinWindow', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const H = 60 * 60 * 1000;

  it('counts an installation seen an hour ago', () => {
    expect(isWithinWindow('2026-08-20T11:00:00Z', now, 48 * H)).toBe(true);
  });

  it('does not count one dormant for a week', () => {
    expect(isWithinWindow('2026-08-13T12:00:00Z', now, 48 * H)).toBe(false);
  });

  // Postgres hands back a Date for TIMESTAMPTZ while SQLite hands back the ISO
  // string. Comparing without normalising is the bug class that only ever shows
  // up in production — see the hub row-shape trap.
  it('accepts a Date, as the Postgres driver returns for TIMESTAMPTZ', () => {
    expect(isWithinWindow(new Date('2026-08-20T11:00:00Z'), now, 48 * H)).toBe(true);
    expect(isWithinWindow(new Date('2026-08-13T12:00:00Z'), now, 48 * H)).toBe(false);
  });

  it('treats a missing or unparseable last_seen as dormant rather than live', () => {
    // Blocking on garbage would resurrect the false positive we are removing.
    expect(isWithinWindow(null, now, 48 * H)).toBe(false);
    expect(isWithinWindow('not a timestamp', now, 48 * H)).toBe(false);
  });

  it('is inclusive at the boundary and excludes just beyond it', () => {
    expect(isWithinWindow('2026-08-18T12:00:00Z', now, 48 * H)).toBe(true);
    expect(isWithinWindow('2026-08-18T11:59:59Z', now, 48 * H)).toBe(false);
  });

  it('does not treat a clock-skewed future last_seen as dormant', () => {
    expect(isWithinWindow('2026-08-20T12:00:05Z', now, 48 * H)).toBe(true);
  });
});

describe('liveInstallWindowMs', () => {
  it('defaults to 48 hours', () => {
    expect(DEFAULT_LIVE_INSTALL_WINDOW_HOURS).toBe(48);
    expect(liveInstallWindowMs({})).toBe(48 * 60 * 60 * 1000);
  });

  it('honours an operator override in hours', () => {
    expect(liveInstallWindowMs({ AGENFK_HUB_LIVE_INSTALL_WINDOW_HOURS: '6' })).toBe(6 * 60 * 60 * 1000);
  });

  it('accepts a fractional override', () => {
    expect(liveInstallWindowMs({ AGENFK_HUB_LIVE_INSTALL_WINDOW_HOURS: '0.5' })).toBe(30 * 60 * 1000);
  });

  // A malformed value must not silently become "block nothing": that would turn
  // a typo into permission to merge over a machine that is still ingesting.
  it('falls back to the default when the override is not a positive number', () => {
    for (const bad of ['', 'soon', '0', '-3', 'NaN']) {
      expect(liveInstallWindowMs({ AGENFK_HUB_LIVE_INSTALL_WINDOW_HOURS: bad })).toBe(48 * 60 * 60 * 1000);
    }
  });
});

describe('resolveAliasKey', () => {
  it('returns the key unchanged when nothing aliases it', () => {
    expect(resolveAliasKey('dan@cglab.com', new Map())).toBe('dan@cglab.com');
  });

  it('maps a merged-away key onto its target', () => {
    const aliases = new Map([['osuser:gcs@d13762b1', 'guilherme@cglab.com']]);
    expect(resolveAliasKey('osuser:gcs@d13762b1', aliases)).toBe('guilherme@cglab.com');
  });

  // Chains happen: an identity merged once can be merged again. Resolving only
  // one hop would land a waking machine on an identity that no longer exists.
  it('follows a chain of merges to the final identity', () => {
    const aliases = new Map([
      ['osuser:gcs@d13762b1', 'old@cglab.com'],
      ['old@cglab.com', 'new@cglab.com'],
    ]);
    expect(resolveAliasKey('osuser:gcs@d13762b1', aliases)).toBe('new@cglab.com');
  });

  // Defensive: a cycle should degrade to a stable answer, never hang ingest.
  it('breaks a cycle instead of looping forever', () => {
    const aliases = new Map([['a', 'b'], ['b', 'a']]);
    expect(['a', 'b']).toContain(resolveAliasKey('a', aliases));
  });

  it('stops after a bounded number of hops', () => {
    const aliases = new Map<string, string>();
    for (let i = 0; i < 100; i++) aliases.set(`k${i}`, `k${i + 1}`);
    expect(() => resolveAliasKey('k0', aliases)).not.toThrow();
  });
});
