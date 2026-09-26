/**
 * Dashboard URL construction for `agenfk ui` / `agenfk ui --open <itemId>`.
 *
 * Kept in a leaf module (no commander, no side effects) so the URL contract
 * is unit-testable: the base-URL resolution and the deep-link query string are
 * the user-facing behaviour; the browser launch itself is environmental.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_UI_URL = 'http://localhost:5173';

/**
 * Resolve the dashboard base URL the way `agenfk ui` always has: the URL the
 * dev server recorded in `<rootDir>/.agenfk/ui.log` wins; anything else (no
 * log, unparseable log) falls back to the default dev port.
 */
export function resolveDashboardUrl(rootDir: string): string {
  let logContent: string;
  try {
    logContent = fs.readFileSync(path.join(rootDir, '.agenfk', 'ui.log'), 'utf8');
  } catch {
    /*
     * NO VITE LOG: the API is probably serving the UI itself (one origin,
     * CGLAB-165), and its port is the one thing that knows where. Without this
     * the fallback stayed 5173 - a port nothing serves any more once the API
     * carries the bundle - and `agenfk ui` would open a browser at a dead URL.
     */
    try {
      const port = fs.readFileSync(path.join(os.homedir(), '.agenfk', 'server-port'), 'utf8').trim();
      if (port) return `http://localhost:${port}`;
    } catch { /* no server either; the default is still usable */ }
    return DEFAULT_UI_URL;
  }
  const match = logContent.match(/http:\/\/localhost:\d+/);
  return match ? match[0] : DEFAULT_UI_URL;
}

/**
 * Build the URL `agenfk ui --open <itemId>` launches the browser with.
 *
 * `?item=<itemId>` makes the KanbanBoard pre-fill the Search Box with the id
 * and run the search (drill-down + highlight + scroll, exactly like typing
 * the id into the box). `&project=<projectId>` — appended only when a
 * project resolves — makes the board open on the project the item belongs to,
 * since the board's default project otherwise comes from localStorage.
 * `&view=overview` makes the board also open the card, on Overview: where a
 * person approves a step (c8e35fb8).
 */
export function buildUiOpenUrl(
  base: string,
  itemId: string,
  projectId?: string | null,
  /** `view: 'overview'` opens the card itself on its Overview tab (c8e35fb8). */
  opts: { view?: 'overview' } = {},
): string {
  const params = new URLSearchParams();
  params.set('item', itemId);
  if (projectId) params.set('project', projectId);
  if (opts.view) params.set('view', opts.view);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${params.toString()}`;
}
