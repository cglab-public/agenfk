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
import { DEFAULT_API_PORT } from '@agenfk/telemetry';

/**
 * The dashboard's base URL: the server's own port, since the server serves the
 * board (one origin, CGLAB-165; 24a7b899: nothing else does). A `ui.log` an
 * older install's vite process left behind is ignored - it names a port nothing
 * serves any more. `_rootDir` is kept for the callers' signature.
 */
export function resolveDashboardUrl(_rootDir: string): string {
  try {
    const port = fs.readFileSync(path.join(os.homedir(), '.agenfk', 'server-port'), 'utf8').trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* no server recorded: the default port */ }
  return `http://localhost:${DEFAULT_API_PORT}`;
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
