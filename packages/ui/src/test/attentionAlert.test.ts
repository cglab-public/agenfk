/**
 * @vitest-environment jsdom
 *
 * Deciding whether an agent going quiet is worth interrupting somebody for.
 *
 * Two decisions, kept apart because they fail differently.
 *
 * **Is this new?** The signal is a STATE, not an event. A card sits in
 * `blocked` for as long as nobody answers it, and `failed` never ages out at
 * all, so a rule written on the state rather than on the transition into it is
 * an alarm that repeats until the user disables the feature. Worse at startup,
 * where every run that failed last week is already in the list.
 *
 * **Is the user asking to be told?** Four settings that compose in a way that
 * is easy to get subtly wrong.
 *
 * What counts as "needs you" is deliberately NOT decided here — it is
 * `NEEDS_A_PERSON` from cardState.ts. The card dot and the sidebar count
 * already disagreed once by spelling that rule twice, and a notification that
 * fired off a third list would be the same bug a third time.
 */
import { describe, it, expect } from 'vitest';
import {
  becameBlocked, newlyBlocked, planAttentionAlert, type AttentionSettings,
} from '../attentionAlert';
import { NEEDS_A_PERSON } from '../cardState';
import type { SessionState } from '../sessionRow';

const settings = (over: Partial<AttentionSettings> = {}): AttentionSettings => ({
  attentionAlerts: true,
  attentionSound: true,
  soundTiming: 'unfocused',
  osNotifications: true,
  ...over,
});

describe('noticing that an agent started needing a person', () => {
  it('fires on the transition into every state that needs one', () => {
    // Read FROM the shared set rather than listing the three states again.
    // Listing them is how the fourth spelling gets written.
    for (const state of NEEDS_A_PERSON) {
      expect(becameBlocked('running', state), state).toBe(true);
    }
  });

  it('covers blocked, failed and unverifiable, which is what the set says', () => {
    // Pinned so that a change to NEEDS_A_PERSON shows up here as well as in
    // cardState's own suite — the loop above would silently pass on an empty
    // set, and on a set that had lost a member.
    expect([...NEEDS_A_PERSON].sort()).toEqual(['blocked', 'failed', 'unverifiable']);
  });

  it('does not fire again while it stays there', () => {
    // THE test. A blocked card stays blocked until somebody answers it, so a
    // rule written on the state alone is a repeating alarm.
    expect(becameBlocked('blocked', 'blocked')).toBe(false);
    expect(becameBlocked('failed', 'failed')).toBe(false);
  });

  it('does not fire for a state that needs nobody', () => {
    for (const next of ['running', 'idle'] as const) {
      expect(becameBlocked('blocked', next), next).toBe(false);
    }
  });

  it('fires when a blocked row moves to a DIFFERENT state that also needs a person', () => {
    // An agent that was waiting for a prompt and then crashed is a second
    // event about the same card, and it is a worse one.
    expect(becameBlocked('blocked', 'failed')).toBe(true);
  });

  it('fires for a row whose previous state was never recorded', () => {
    // A terminal opened a moment ago, blocked on its first prompt. Treating
    // "unseen" as "already known" would swallow the alert that matters most.
    expect(becameBlocked(undefined, 'blocked')).toBe(true);
  });
});

describe('the first look records rather than announces', () => {
  const rows = (...states: SessionState[]) =>
    states.map((state, n) => ({ key: `row-${n}`, state }));

  it('says nothing about what was already on screen when the app started', () => {
    // Without this, launching the app in front of last week's failed runs
    // opens with a burst of banners about work that finished days ago — which
    // is the fastest way to teach somebody to turn notifications off.
    const first = newlyBlocked(rows('failed', 'blocked', 'running'), new Map(), false);
    expect(first.alerts).toEqual([]);
    expect(first.seen.size).toBe(3);
  });

  it('announces the next one, because by then it is news', () => {
    const first = newlyBlocked(rows('running'), new Map(), false);
    const second = newlyBlocked(rows('blocked'), first.seen, true);
    expect(second.alerts.map(r => r.key)).toEqual(['row-0']);
  });

  it('announces a row that appears after the first look', () => {
    const first = newlyBlocked(rows('running'), new Map(), false);
    const second = newlyBlocked(
      [...rows('running'), { key: 'new-session', state: 'blocked' as SessionState }],
      first.seen,
      true,
    );
    expect(second.alerts.map(r => r.key)).toEqual(['new-session']);
  });

  it('says nothing twice about the same row', () => {
    const a = newlyBlocked(rows('running'), new Map(), false);
    const b = newlyBlocked(rows('blocked'), a.seen, true);
    const c = newlyBlocked(rows('blocked'), b.seen, true);
    expect(b.alerts).toHaveLength(1);
    expect(c.alerts).toHaveLength(0);
  });

  it('announces again after the agent went back to work and stopped once more', () => {
    // A second question deserves a second alert. Remembering "already told
    // them" forever makes the feature work exactly once per session.
    const a = newlyBlocked(rows('blocked'), new Map(), false);
    const b = newlyBlocked(rows('running'), a.seen, true);
    const c = newlyBlocked(rows('blocked'), b.seen, true);
    expect(c.alerts).toHaveLength(1);
  });

  it('forgets a row that disappeared rather than holding its last state', () => {
    // A card that comes back has genuinely changed since we last knew anything
    // about it, and a stale memory would swallow the alert.
    const a = newlyBlocked(rows('blocked'), new Map(), false);
    const b = newlyBlocked([], a.seen, true);
    expect(b.seen.size).toBe(0);
    const c = newlyBlocked(rows('blocked'), b.seen, true);
    expect(c.alerts).toHaveLength(1);
  });
});

describe('what the user asked to be told with', () => {
  it('does nothing at all when alerts are off', () => {
    // The master switch is the one control a user reaches for when the app is
    // being annoying. It has to silence everything, not most things.
    expect(planAttentionAlert(settings({ attentionAlerts: false }), false))
      .toEqual({ sound: false, banner: false });
  });

  it('plays and banners when everything is on and the window is behind something', () => {
    expect(planAttentionAlert(settings(), false)).toEqual({ sound: true, banner: true });
  });

  it('stays silent while the user is looking at the window, by default', () => {
    // 'unfocused' is the default because a sound aimed at somebody already
    // watching the thing that made it carries no information.
    expect(planAttentionAlert(settings(), true).sound).toBe(false);
  });

  it('plays even when focused if the user asked for always', () => {
    expect(planAttentionAlert(settings({ soundTiming: 'always' }), true).sound).toBe(true);
  });

  it('keeps the banner independent of the sound', () => {
    // Someone in an open office wants the banner and not the sound; someone
    // sharing their screen wants the opposite. Tying them together means the
    // only way to stop one is to stop both.
    expect(planAttentionAlert(settings({ attentionSound: false }), false))
      .toEqual({ sound: false, banner: true });
    expect(planAttentionAlert(settings({ osNotifications: false }), false))
      .toEqual({ sound: true, banner: false });
  });

  it('does not apply the sound timing to the banner', () => {
    /*
     * They are decided in different places, on purpose. The renderer knows
     * whether its DOCUMENT has focus; only the main process knows whether the
     * WINDOW is in front, and a window behind another application can still
     * report a focused document. So the banner's "only when unfocused" rule
     * lives in main/attentionNotice.ts and this function must not second-guess
     * it — two answers to one question is how the banner ends up suppressed by
     * whichever side is wrong.
     */
    expect(planAttentionAlert(settings({ soundTiming: 'always' }), true).banner).toBe(true);
    expect(planAttentionAlert(settings({ soundTiming: 'unfocused' }), true).banner).toBe(true);
  });
});
