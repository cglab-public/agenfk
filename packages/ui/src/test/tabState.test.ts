/**
 * The tab for the pane you are not looking at (CGLAB-191).
 *
 * Five sessions, one visible. Today the four you cannot see carry a label and
 * nothing else, so an agent that failed behind another tab is invisible until
 * you click it — which means you only find failures by going looking for them,
 * one tab at a time.
 *
 * TWO FAILURES, opposite directions. Painting nothing is the one that costs a
 * person time. Painting everything is the one that makes the strip useless: a
 * dot on every tab announcing that a quiet agent is quiet is the same noise as
 * a chip on every card announcing an absence, and it buries the two states
 * that actually need somebody.
 */
import { describe, it, expect } from 'vitest';
import { tabIndicator, tabDotClass, tabsNeedingAPerson } from '../tabState';

describe('what a tab says', () => {
  it('stays quiet for an idle agent, which is most of them', () => {
    const i = tabIndicator('idle');
    expect(i.state, 'a dot was painted on a quiet tab').toBeNull();
    expect(i.label).toBeNull();
    expect(i.urgent).toBe(false);
  });

  it('says a failed agent failed, and marks it urgent', () => {
    const i = tabIndicator('failed');
    expect(i.state).toBe('failed');
    expect(i.label).toBe('failed');
    expect(i.urgent, 'a failure did not read as urgent').toBe(true);
  });

  it('treats blocked as urgent too, because both want a person', () => {
    expect(tabIndicator('blocked').urgent).toBe(true);
  });

  it('shows running without shouting about it', () => {
    /*
     * The good case still has to be visible — "the tab for the pane you are
     * not looking at still tells you it is alive" — but it must not compete
     * with the two that need somebody.
     */
    const i = tabIndicator('running');
    expect(i.state).toBe('running');
    expect(i.urgent, 'a healthy agent was marked as needing a person').toBe(false);
  });

  it('stays quiet for a session with no row yet', () => {
    // A tab exists from the moment it is opened; the row appears when the
    // agent first produces something. Treating the gap as a fault would paint
    // a dot on every tab for its first second.
    expect(tabIndicator(undefined).state).toBeNull();
  });
});

describe('the colours', () => {
  it('gives failure and blocking the only saturated colours', () => {
    expect(tabDotClass('failed')).toContain('red');
    expect(tabDotClass('blocked')).toContain('amber');
  });

  it('does not paint running in an alarm colour', () => {
    const running = tabDotClass('running');
    expect(running).not.toContain('red');
    expect(running).not.toContain('amber');
  });

  it('gives every state a class, so none renders as an invisible dot', () => {
    for (const s of ['running', 'blocked', 'failed', 'idle'] as const) {
      expect(tabDotClass(s), `${s} has no colour`).toMatch(/bg-/);
    }
  });
});

describe('how many want a person', () => {
  it('counts failures and blocks, not healthy agents', () => {
    expect(tabsNeedingAPerson(['running', 'failed', 'idle', 'blocked', 'running'])).toBe(2);
  });

  it('counts by SESSION, since two agents can share a card', () => {
    // One agent failing says nothing about the other on the same card, so two
    // failed sessions are two things to look at rather than one.
    expect(tabsNeedingAPerson(['failed', 'failed'])).toBe(2);
  });

  it('ignores sessions with no row', () => {
    expect(tabsNeedingAPerson([undefined, undefined, 'failed'])).toBe(1);
  });

  it('is zero when everything is fine, rather than undefined', () => {
    // The caller renders this number; NaN or undefined in a strip header is a
    // rendering fault reading as a count.
    expect(tabsNeedingAPerson(['running', 'idle'])).toBe(0);
    expect(tabsNeedingAPerson([])).toBe(0);
  });
});
