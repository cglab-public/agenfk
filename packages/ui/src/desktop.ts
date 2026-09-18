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
