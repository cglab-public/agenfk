/**
 * The herdr panes, as rows a person can read (96953f6a / CGLAB-266).
 *
 * `w2:p1P` tells nobody anything. What a developer recognises is the repository
 * and what the agent is doing in it — and herdr answers both outright, so none
 * of this has to be inferred from a screen.
 *
 * TWO THINGS ARE PASSED THROUGH RATHER THAN REINTERPRETED. `agent_status` is
 * herdr's own word, including `unknown`, which it returns for shells instead of
 * guessing `idle`; turning that into a guess here would invent a fact the
 * multiplexer deliberately refused to state. And `terminal_title_stripped` is
 * the title already cleaned, which this repository otherwise derives by hand.
 *
 * Pure, so the ordering and the labels are testable without a socket or a render.
 */

export interface RawPane {
  readonly pane_id: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly terminal_title_stripped?: string;
  readonly [k: string]: unknown;
}

export interface PaneRow {
  readonly paneId: string;
  /** What the agent is doing, or the directory when herdr has no title. */
  readonly title: string;
  readonly path: string;
  readonly dir: string;
  /** The harness, or `shell` — never blank. */
  readonly agent: string;
  /** herdr's own word. Not translated. */
  readonly status: string;
  readonly needsAPerson: boolean;
}

export interface PaneGroup {
  readonly dir: string;
  readonly path: string;
  readonly panes: readonly PaneRow[];
  readonly needsAPerson: number;
}

/** herdr's word for a pane waiting on a human. */
const BLOCKED = 'blocked';

/** Where a pane with no cwd is filed. It is still a pane somebody is running. */
const NO_DIRECTORY = 'no directory';

function lastSegment(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export function paneRows(panes: readonly RawPane[]): PaneRow[] {
  return panes.map(p => {
    const path = typeof p.cwd === 'string' && p.cwd ? p.cwd : '';
    const dir = path ? lastSegment(path) : NO_DIRECTORY;
    const title = (p.terminal_title_stripped ?? '').trim();
    return {
      paneId: p.pane_id,
      // A pane with no title is not a blank row: the directory is still
      // something the reader can place.
      title: title || dir,
      path,
      dir,
      agent: (p.agent ?? '').trim() || 'shell',
      status: (p.agent_status ?? '').trim() || 'unknown',
      needsAPerson: p.agent_status === BLOCKED,
    };
  });
}

/**
 * Panes grouped by the directory they run in, most urgent group first.
 *
 * THE WHOLE POINT OF SHOWING THIS is the pane nobody is watching, so a list
 * sorted by name buries the one row that needed the screen to exist. Ties fall
 * back to the path, which keeps the order from wobbling between reads — the
 * same list rendered twice must not reorder itself.
 *
 * Grouped by the FULL path, labelled by the last segment: `/x/agenfk` and
 * `/y/agenfk` are different work that reads the same.
 */
export function groupPanes(rows: readonly PaneRow[]): PaneGroup[] {
  const byPath = new Map<string, PaneRow[]>();
  for (const r of rows) {
    const key = r.path || NO_DIRECTORY;
    const list = byPath.get(key) ?? [];
    list.push(r);
    byPath.set(key, list);
  }
  return [...byPath.entries()]
    .map(([path, panes]) => ({
      dir: path === NO_DIRECTORY ? NO_DIRECTORY : lastSegment(path),
      path: path === NO_DIRECTORY ? '' : path,
      panes,
      needsAPerson: panes.filter(p => p.needsAPerson).length,
    }))
    .sort((a, b) => b.needsAPerson - a.needsAPerson || a.path.localeCompare(b.path));
}
