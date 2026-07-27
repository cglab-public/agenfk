// Pure helpers for the Admin → Installations hidden-people UI (CGLAB-31):
// partitioning rows into visible/hidden, deriving the hide target key from
// an installation row, and deciding which rows the table renders.

export interface InstallationRowLike {
  id: string;
  gitEmail: string | null;
  hidden?: boolean;
}

/**
 * The hide action is keyed on the person's user_key (lowercased git email).
 * Returns null when the row has no git email — such installations cannot be
 * attributed to a person and therefore cannot be hidden from the UI.
 */
export function hideTargetKey(row: Pick<InstallationRowLike, 'gitEmail'>): string | null {
  const email = row.gitEmail?.trim().toLowerCase();
  return email ? email : null;
}

/**
 * Rows rendered in the installations table. When showHidden is false the
 * hidden rows are excluded (the backend already excludes them by default;
 * this keeps the client-side toggle consistent when includeHidden=1 rows
 * are loaded).
 */
export function visibleInstallationRows<T extends InstallationRowLike>(rows: T[], showHidden: boolean): T[] {
  if (showHidden) return rows;
  return rows.filter(r => !r.hidden);
}

/**
 * Partition into visible vs hidden rows — drives both the table and the
 * "N hidden" toggle label.
 */
export function partitionHiddenRows<T extends InstallationRowLike>(rows: T[]): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const r of rows) (r.hidden ? hidden : visible).push(r);
  return { visible, hidden };
}

/**
 * Whether the Hide button should be enabled for a row: only visible rows
 * with an attributable git email can be hidden.
 */
export function canHideRow(row: InstallationRowLike): boolean {
  return !row.hidden && hideTargetKey(row) !== null;
}
