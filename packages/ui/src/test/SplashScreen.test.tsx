/**
 * @vitest-environment jsdom
 *
 * The startup curtain (004bd193).
 *
 * The brand book sanctions the animation in exactly one place - the first
 * load - and this is it. So the test is about the LIFECYCLE: it shows the
 * lockup, it leaves on its own, and it is not mounted again.
 */
import { render, screen, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { SplashScreen } from '../components/SplashScreen';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the startup splash', () => {
  it('shows the lockup, then leaves on its own', () => {
    const onDone = vi.fn();
    render(<SplashScreen holdMs={900} onDone={onDone} />);
    expect(screen.getByTestId('splash-screen')).toBeInTheDocument();
    // The mark IS the screen; a splash with no brand would be a blank curtain.
    expect(screen.getByLabelText('AgEnFK')).toBeInTheDocument();

    // Still there just before the hold ends - it is not a flash.
    act(() => { vi.advanceTimersByTime(880); });
    expect(screen.getByTestId('splash-screen')).toBeInTheDocument();

    // Gone after the fade, and it said so.
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('splash-screen')).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('does NOT unmount at the start of the fade', () => {
    // Cutting the transition off is the one frame the component exists for.
    render(<SplashScreen holdMs={100} />);
    act(() => { vi.advanceTimersByTime(120); });
    const el = screen.getByTestId('splash-screen');
    expect(el.className).toMatch(/opacity-0/);   // fading
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('splash-screen')).toBeNull();
  });
});
