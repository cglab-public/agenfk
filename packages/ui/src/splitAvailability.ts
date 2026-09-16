/**
 * Whether two terminals fit, and what to say when they do not (CGLAB-192).
 *
 * *"Split is disabled with its reason on it rather than absent."* A control
 * that vanishes teaches nothing and invites the same attempt tomorrow; one that
 * is greyed out and says why teaches once.
 *
 * THE WIDTHS ARE MEASURED, NOT GUESSED. A terminal pane's floor is 592 px - 576
 * px of glyph at this font plus the viewport scrollbar - and the worktree panel
 * is a fixed 288 px that sits in the same row. So on a 1440 window with the
 * 224 px sidebar the main column is 1216 px: two panes fit with 32 px to spare,
 * and opening the git panel costs you the split. Three panes do not fit at
 * 1920 either, which is why a third is not a thing to add later.
 *
 * SPLIT IS ASKED FOR, NEVER AUTOMATIC. Three agents running does not mean two
 * panes open. Only a person knows which pair belongs side by side - the lead
 * and the sub-agent whose diff it is about to review - and guessing produces a
 * layout that is wrong most of the time and costs a pane to undo.
 */

/** A terminal pane below this is unusable: 576 px of glyph plus the scrollbar. */
export const PANE_FLOOR_PX = 592;

/** WorktreePanel is `w-72`. It shares the row rather than overlaying it. */
export const WORKTREE_PANEL_PX = 288;

export interface SplitAvailability {
  /** True when the control may be pressed. */
  readonly enabled: boolean;
  /**
   * Why not, in words a person can act on. Null when enabled.
   *
   * Every reason names the thing to CHANGE, not the rule that was broken:
   * "open a second terminal" rather than "fewer than two sessions".
   */
  readonly reason: string | null;
}

const OK: SplitAvailability = { enabled: true, reason: null };

export interface SplitInputs {
  /** How many terminals are open, including the one on screen. */
  readonly sessionCount: number;
  /** Width available to the panes and the panel together. */
  readonly rowWidthPx: number;
  /** Whether the fixed-width git panel is taking part of that row. */
  readonly worktreePanelOpen: boolean;
}

/**
 * Can this window show two terminals at once?
 *
 * Reasons are checked cheapest-first and only ONE is returned, because a
 * control that lists every objection at once is read as broken rather than as
 * unavailable.
 */
export function splitAvailability({ sessionCount, rowWidthPx, worktreePanelOpen }: SplitInputs): SplitAvailability {
  if (sessionCount < 2) {
    return { enabled: false, reason: 'Open a second terminal to split the view.' };
  }
  const usable = rowWidthPx - (worktreePanelOpen ? WORKTREE_PANEL_PX : 0);
  if (usable < PANE_FLOOR_PX * 2) {
    /*
     * The panel is named when it is the difference, because that is the one a
     * person can act on in a second. Widening a window they may not be able to
     * widen is worse advice.
     */
    if (worktreePanelOpen && rowWidthPx >= PANE_FLOOR_PX * 2) {
      return { enabled: false, reason: 'Close the git panel to fit two terminals.' };
    }
    return { enabled: false, reason: `The window is too narrow for two terminals (needs ${PANE_FLOOR_PX * 2} px).` };
  }
  return OK;
}

/**
 * What the split must give up when the git panel opens.
 *
 * The panel wins, and the split closes rather than both panes shrinking below
 * the floor. A terminal narrower than its floor is not a smaller terminal - it
 * is one that wraps every line, which is worse than not being on screen.
 */
export function splitSurvivesPanel(rowWidthPx: number): boolean {
  return rowWidthPx - WORKTREE_PANEL_PX >= PANE_FLOOR_PX * 2;
}
