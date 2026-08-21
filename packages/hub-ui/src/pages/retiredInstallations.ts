// Pure helpers for the Admin → Installations retirement UI (CGLAB-64), the
// machine-level counterpart to hiddenPeople.ts.
//
// Retiring marks a dead endpoint — a wiped laptop, a departed dev's install —
// so it stops counting as a live target. That matters beyond tidiness: an
// upgrade or repoint campaign board waits on every non-retired installation,
// so one machine that is never coming back keeps an old hub DNS name
// undroppable forever.

export interface RetirableRowLike {
  id: string;
  /** Absent on responses from a hub predating the retirement columns. */
  retired?: boolean;
}

/**
 * Whether the Retire action applies. A missing flag counts as live so the
 * action stays available against an older hub rather than silently vanishing.
 */
export function canRetireRow(row: RetirableRowLike): boolean {
  return row.retired !== true;
}

/** Whether the Restore action applies. Exact complement of canRetireRow. */
export function canUnretireRow(row: RetirableRowLike): boolean {
  return !canRetireRow(row);
}

/**
 * Rows the table renders. The backend already excludes retired installations
 * unless asked with ?includeRetired=1; this keeps the client-side toggle
 * consistent once those rows are loaded.
 */
export function visibleByRetirement<T extends RetirableRowLike>(rows: T[], showRetired: boolean): T[] {
  if (showRetired) return rows;
  return rows.filter(r => !r.retired);
}

/** Drives the "Show retired (N)" toggle label. */
export function countRetired(rows: RetirableRowLike[]): number {
  return rows.reduce((n, r) => (r.retired ? n + 1 : n), 0);
}

/**
 * Confirm copy for the destructive half of the action. It has to say both
 * things: that key revocation is permanent (so nobody retires a live machine
 * casually) and that history survives (so nobody avoids retiring a dead one
 * out of fear of losing metrics).
 */
export function retireConfirmMessage(installationId: string): string {
  return (
    `Retire ${installationId}? Its API keys are revoked permanently and any pending ` +
    `upgrade or repoint work for it is cancelled, so campaign boards can finish. ` +
    `Historical events and metrics are kept — they belong to the person, not the machine. ` +
    `Hiding it is reversible; the revoked keys are not, so the machine would have to re-join.`
  );
}
