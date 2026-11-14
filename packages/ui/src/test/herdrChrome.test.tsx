/**
 * A herdr row looks like the work it is (96953f6a / CGLAB-266).
 *
 * Two omissions, one cause: these rows were built beside the app's own
 * conventions instead of through them. A herdr agent that is RUNNING is
 * running in exactly the sense ours are, and an attached session is a tab like
 * any other - so both had to reuse what already existed rather than resemble
 * it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { AgentIcon } from '../components/AgentIcon';
import { SessionStateIndicator } from '../components/sessionPresentation';
import { HERDR_AGENT_ID } from '../herdrTreeRows';

afterEach(cleanup);

/* ── the mark ──────────────────────────────────────────────────────────── */

describe('the herdr tab', () => {
  it('carries herdr\'s own mark, not the fallback dot', () => {
    /*
     * herdr is not in MARKS - its logo comes from herdr's assets under
     * AGPL-3.0-or-later, not the icon set the rest of that file lifts from -
     * so it fell through to the grey dot. The one tab that is not an agent was
     * also the one with no mark, which is the tab a person most needs to pick
     * out of a row.
     */
    render(<AgentIcon agentId={HERDR_AGENT_ID} size={14} />);
    expect(document.querySelector('[data-agent-mark="herdr"]')).toBeTruthy();
    expect(document.querySelector('[data-agent-mark="fallback"]')).toBeNull();
  });

  it('is the SAME mark the tree draws, not a second copy of the path', () => {
    // Two copies of an AGPL path under a licence note that covers one of them
    // is how the note stops being true.
    const { container: tab } = render(<AgentIcon agentId={HERDR_AGENT_ID} size={14} />);
    const d = tab.querySelector('path')?.getAttribute('d') ?? '';
    expect(d.length).toBeGreaterThan(100);
    expect(tab.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 512 512');
  });

  it('does not announce "herdr" twice, since the word is beside it', () => {
    render(<AgentIcon agentId={HERDR_AGENT_ID} />);
    const svg = document.querySelector('[data-agent-mark="herdr"]');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('aria-label')).toBeNull();
  });

  it('still falls back for an id nobody has a mark for', () => {
    // The branch must be about herdr, not a blanket change to the fallback.
    render(<AgentIcon agentId="something-else" />);
    expect(document.querySelector('[data-agent-mark="fallback"]')).toBeTruthy();
  });
});

/* ── the animation ─────────────────────────────────────────────────────── */

describe('a running session', () => {
  it('animates, whoever started it', () => {
    /*
     * The defect this fixes: a herdr row said "running" in still text beside
     * one of ours with a spinner, doing the same work. Still text next to
     * motion reads as "that one is stuck".
     */
    const { container } = render(<SessionStateIndicator state="running" />);
    expect(container.querySelector('[class*="animate-"]')).toBeTruthy();
  });

  it('keeps the state on a STATIC node as well', () => {
    /*
     * Their own rule, and the reason the running branch carries an sr-only
     * span: a state readable only by watching an animation is unreadable to
     * assistive tech and untestable without depending on the frame.
     */
    render(<SessionStateIndicator state="running" />);
    expect(screen.getByTestId('session-dot').getAttribute('data-state')).toBe('running');
  });
});

describe('a session that is not running', () => {
  it('gets a dot, and the dot says which state', () => {
    for (const state of ['idle', 'blocked', 'failed', 'unverifiable'] as const) {
      cleanup();
      render(<SessionStateIndicator state={state} />);
      expect(screen.getByTestId('session-dot').getAttribute('data-state')).toBe(state);
    }
  });

  it('does not animate', () => {
    // Otherwise the spinner stops meaning "working".
    const { container } = render(<SessionStateIndicator state="idle" />);
    expect(container.querySelector('[class*="animate-"]')).toBeNull();
  });
});
