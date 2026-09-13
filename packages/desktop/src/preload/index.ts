/**
 * Preload — the only bridge between the renderer and the main process.
 *
 * This file is a security boundary, not a convenience layer. The renderer runs
 * the same bundle a browser would, so anything exposed here is reachable by
 * every script in that bundle. Expose named, narrow operations; never a
 * general-purpose escape hatch like `spawn` or `ipcRenderer` itself.
 *
 * The UI uses the presence of `window.agenfkDesktop` to decide whether to
 * render the desktop shell (sidebar + session tabs) or stay the plain board
 * it is in a browser — see CGLAB-168.
 */
import { contextBridge } from 'electron';

export interface AgenfkDesktopApi {
  /** Marks this as the desktop shell. Checked by the UI at startup. */
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

const api: AgenfkDesktopApi = {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('agenfkDesktop', api);
