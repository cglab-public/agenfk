import { useSyncExternalStore } from 'react';

/**
 * Am I running inside AgEnFK Desktop? (CGLAB-168)
 *
 * The signal is `window.agenfkDesktop`, injected by the Electron preload
 * through contextBridge. It is checked by shape rather than truthiness,
 * because a stray global of the same name would otherwise flip the whole UI
 * into desktop mode — drag regions and a fake title bar inside a browser tab,
 * which is both broken and impossible to diagnose from the outside.
 */

export interface DesktopInfo {
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

interface DesktopBridge extends Partial<DesktopInfo> {
  isDesktop?: unknown;
  fullScreen?: {
    current?: unknown;
    onChange?: unknown;
  };
}

function bridge(): DesktopBridge | null {
  const candidate = (globalThis as Record<string, unknown>).agenfkDesktop;
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate as DesktopBridge;
}

/** True only inside the Electron shell. */
export function isDesktop(): boolean {
  return bridge()?.isDesktop === true;
}

/**
 * Platform and runtime versions from the preload, or null in a browser.
 * Every field is defaulted: the bridge is another process's data, and a
 * missing key must not take a render down.
 */
export function desktopInfo(): DesktopInfo | null {
  const b = bridge();
  if (!b || b.isDesktop !== true) return null;
  return {
    platform: typeof b.platform === 'string' ? b.platform : 'unknown',
    versions: {
      electron: b.versions?.electron ?? '',
      chrome: b.versions?.chrome ?? '',
      node: b.versions?.node ?? '',
    },
  };
}

/**
 * Whether the desktop window is full screen. False in a browser, and false for
 * a preload that predates the question.
 *
 * Absent reads as windowed on purpose: that keeps the shell's macOS title bar,
 * and the opposite mistake is a window with nothing to drag it by.
 */
export function isFullScreen(): boolean {
  const current = bridge()?.fullScreen?.current;
  if (typeof current !== 'function') return false;
  return current() === true;
}

/** Every change of full screen from here on; a no-op outside the desktop. */
export function onFullScreenChange(cb: (fullScreen: boolean) => void): () => void {
  const onChange = bridge()?.fullScreen?.onChange;
  if (typeof onChange !== 'function') return () => {};
  const off = onChange((value: unknown) => {
    // Another process's data: only a real boolean gets through.
    if (typeof value === 'boolean') cb(value);
  });
  return typeof off === 'function' ? off : () => {};
}

/**
 * Full screen as React state, following the window. An external store, which
 * is what it is: the value lives in the preload, and React reads it through the
 * subscription rather than copying it into state and hoping to stay in step.
 */
export function useFullScreen(): boolean {
  return useSyncExternalStore(onFullScreenChange, isFullScreen, () => false);
}
