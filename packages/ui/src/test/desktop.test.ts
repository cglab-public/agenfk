/**
 * @vitest-environment jsdom
 *
 * CGLAB-168: how the UI knows it is running inside the desktop app.
 *
 * The signal is `window.agenfkDesktop`, injected by the Electron preload via
 * contextBridge. Getting this wrong in either direction is bad: a false
 * positive puts desktop chrome (a drag region, a fake title bar) into a normal
 * browser tab, and a false negative leaves the desktop window with no way to
 * be moved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { isDesktop, desktopInfo, isFullScreen, onFullScreenChange, useFullScreen } from '../desktop';

const setBridge = (value: unknown): void => {
  Object.defineProperty(window, 'agenfkDesktop', {
    value, configurable: true, writable: true,
  });
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});

describe('isDesktop', () => {
  it('is false in a plain browser', () => {
    expect(isDesktop()).toBe(false);
  });

  it('is true when the preload injected the bridge', () => {
    setBridge({ isDesktop: true, platform: 'darwin', versions: { electron: '40.0.0', chrome: '1', node: '24' } });
    expect(isDesktop()).toBe(true);
  });

  it('is false when something else defined the global with the wrong shape', () => {
    // Defensive: the value is whatever is on window, and a truthiness check
    // would let any stray global switch the whole UI into desktop mode.
    setBridge({ somethingElse: true });
    expect(isDesktop()).toBe(false);
  });

  it('is false for a truthy non-object', () => {
    setBridge('yes');
    expect(isDesktop()).toBe(false);
  });

  it('is false when isDesktop is explicitly false', () => {
    setBridge({ isDesktop: false });
    expect(isDesktop()).toBe(false);
  });
});

describe('desktopInfo', () => {
  it('returns null in a browser', () => {
    expect(desktopInfo()).toBeNull();
  });

  it('returns the platform and versions the preload exposed', () => {
    setBridge({ isDesktop: true, platform: 'darwin', versions: { electron: '40.10.6', chrome: '130', node: '24.15.0' } });
    expect(desktopInfo()?.platform).toBe('darwin');
    expect(desktopInfo()?.versions.electron).toBe('40.10.6');
  });

  it('does not throw when the bridge is present but partial', () => {
    setBridge({ isDesktop: true });
    expect(() => desktopInfo()).not.toThrow();
  });
});

/**
 * Full screen, which only the window knows (the empty title bar on macOS).
 *
 * Read through the same shape check as everything else here: the bridge is
 * another process's data, and an older preload has no `fullScreen` at all.
 * Absent means "not full screen", which keeps the title bar - the safe side,
 * because the other mistake is a window that cannot be dragged.
 */
const fullScreenBridge = (initial: boolean) => {
  let value = initial;
  const listeners = new Set<(v: unknown) => void>();
  setBridge({
    isDesktop: true, platform: 'darwin', versions: { electron: '40', chrome: '1', node: '24' },
    fullScreen: {
      current: () => value,
      onChange: (cb: (v: unknown) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    },
  });
  return {
    listeners,
    push: (v: unknown) => { if (typeof v === 'boolean') value = v; listeners.forEach(l => l(v)); },
  };
};

describe('isFullScreen', () => {
  it('is false in a browser', () => {
    expect(isFullScreen()).toBe(false);
  });

  it('is false for a preload that predates full screen', () => {
    setBridge({ isDesktop: true, platform: 'darwin' });
    expect(isFullScreen()).toBe(false);
  });

  it('reads what the window last said', () => {
    fullScreenBridge(true);
    expect(isFullScreen()).toBe(true);
  });

  it('takes only a real boolean', () => {
    setBridge({ isDesktop: true, fullScreen: { current: () => 'yes', onChange: () => () => {} } });
    expect(isFullScreen()).toBe(false);
  });
});

describe('onFullScreenChange', () => {
  it('is a harmless no-op in a browser', () => {
    const off = onFullScreenChange(() => {});
    expect(() => off()).not.toThrow();
  });

  it('forwards changes and stops after unsubscribing', () => {
    const b = fullScreenBridge(false);
    const seen: boolean[] = [];
    const off = onFullScreenChange(v => seen.push(v));
    b.push(true);
    off();
    b.push(false);
    expect(seen).toEqual([true]);
    expect(b.listeners.size).toBe(0);
  });

  it('drops a payload that is not a boolean', () => {
    const b = fullScreenBridge(false);
    const seen: boolean[] = [];
    onFullScreenChange(v => seen.push(v));
    b.push('true');
    expect(seen).toEqual([]);
  });
});

describe('useFullScreen', () => {
  it('starts from the current state and follows the window', () => {
    const b = fullScreenBridge(true);
    const { result, unmount } = renderHook(() => useFullScreen());
    expect(result.current).toBe(true);
    act(() => b.push(false));
    expect(result.current).toBe(false);
    unmount();
    expect(b.listeners.size, 'the hook left a listener behind').toBe(0);
  });

  it('is false in a browser', () => {
    const { result } = renderHook(() => useFullScreen());
    expect(result.current).toBe(false);
  });
});
