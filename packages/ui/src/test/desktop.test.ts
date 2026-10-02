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
import { isDesktop, desktopInfo } from '../desktop';

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
