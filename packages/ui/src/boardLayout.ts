/**
 * #262 - the board's layout choices, per viewer: compact mode, and which side
 * columns (Ideas, Paused, Blocked, Archived) are expanded.
 *
 * A convenience, kept in this browser only. Storage that is missing, corrupt
 * or throwing (a private window, blocked site data) gives the defaults, field
 * by field, and a write that fails is dropped: the board renders either way.
 */

export interface BoardLayout {
  compact: boolean;
  collapsed: { ideas: boolean; paused: boolean; blocked: boolean; archived: boolean };
}

export const DEFAULT_BOARD_LAYOUT: BoardLayout = {
  compact: false,
  collapsed: { ideas: true, paused: true, blocked: true, archived: true },
};

const KEY = 'agenfk_board_layout';

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

export function readBoardLayout(): BoardLayout {
  let raw: any;
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { raw = null; }
  const d = DEFAULT_BOARD_LAYOUT;
  const c = raw && typeof raw.collapsed === 'object' ? raw.collapsed : {};
  return {
    compact: bool(raw?.compact, d.compact),
    collapsed: {
      ideas: bool(c?.ideas, d.collapsed.ideas),
      paused: bool(c?.paused, d.collapsed.paused),
      blocked: bool(c?.blocked, d.collapsed.blocked),
      archived: bool(c?.archived, d.collapsed.archived),
    },
  };
}

export function writeBoardLayout(layout: BoardLayout): void {
  try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* not kept: the board still renders */ }
}
