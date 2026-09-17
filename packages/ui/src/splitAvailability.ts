/**
 * Two measurements the panes share, and nothing that refuses a layout.
 *
 * THIS MODULE USED TO DECIDE. `splitAvailability` disabled the Split control
 * below 1184px - two 592px panes - and told the person to widen their window.
 * That let the product refuse an arrangement they could see and wanted, and it
 * was arithmetic dressed as a rule: a narrow pane wraps its lines, and the
 * reader is looking straight at it. The panes are fitted and MARKED now
 * (`layoutPanes().narrow`); what is left here are the two numbers everything
 * else measures with.
 *
 * PANE_FLOOR_PX is the width a terminal wants - 576px of glyph at this font
 * plus the scrollbar, which is 80 columns. It is now the number the DIVIDER
 * stops at while dragging, which is a limit somebody is actively expressing,
 * not a gate on whether they may start.
 */

/** A pane narrower than this wraps: 80 columns of glyph plus the scrollbar. */
export const PANE_FLOOR_PX = 592;

/** WorktreePanel is `w-72`. It shares the row rather than overlaying it. */
export const WORKTREE_PANEL_PX = 288;
