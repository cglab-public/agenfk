/**
 * @vitest-environment jsdom
 *
 * 9569b4d7 — a running verify is visible, and moving, on the card itself.
 * User 2026-09-25: "The running verify should be animated, even with the card
 * closed." The spinner is CSS (no timer); the elapsed time ticks on the
 * board's one seconds clock; reduced motion keeps the icon still.
 */
import { render, screen, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VerifyRunBadge } from '../components/VerifyRunBadge';

const T0 = new Date('2026-09-25T10:00:00.000Z');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('VerifyRunBadge', () => {
  it('shows an animated spinner that stays still under reduced motion', () => {
    render(<VerifyRunBadge run={{ runId: 'r1', step: 'IN_PROGRESS', startedAt: T0.toISOString() }} />);
    const badge = screen.getByTestId('verify-running');
    const icon = badge.querySelector('svg')!;
    expect(icon.getAttribute('class')).toContain('animate-spin');
    expect(icon.getAttribute('class')).toContain('motion-reduce:animate-none');
  });

  it('ticks the elapsed time live', () => {
    render(<VerifyRunBadge run={{ runId: 'r1', step: 'IN_PROGRESS', startedAt: T0.toISOString() }} />);
    expect(screen.getByTestId('verify-running').textContent).toContain('Verifying… 0s');
    act(() => { vi.advanceTimersByTime(72_000); });
    expect(screen.getByTestId('verify-running').textContent).toContain('Verifying… 1m 12s');
  });

  it('says which step it is verifying on hover, without announcing every tick to a screen reader', () => {
    render(<VerifyRunBadge run={{ runId: 'r1', step: 'IN_PROGRESS', startedAt: T0.toISOString() }} />);
    const badge = screen.getByTestId('verify-running');
    expect(badge.getAttribute('title')).toMatch(/IN_PROGRESS/);
    // A live region re-announces its text on every change: once a second, per running card.
    expect(badge.closest('[role="status"], [aria-live="polite"], [aria-live="assertive"]')).toBeNull();
  });

  it('releases its clock when it goes away', () => {
    const { unmount } = render(<VerifyRunBadge run={{ runId: 'r1', step: 'IN_PROGRESS', startedAt: T0.toISOString() }} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
