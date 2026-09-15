/**
 * How one child hub's row on the group-upgrade board reads (CGLAB-183).
 *
 * The distinction this exists to keep honest is `cancel-pending` versus
 * `cancelled`: the parent asked the hub to stop, and until that hub reports
 * back it has NOT stopped. Rendering the two the same way would tell an admin
 * a rollout was halted when it may still be running.
 */

export type GroupTargetState =
  | 'pending'          // served, or not yet polled — no answer either way
  | 'running'          // the child is working through its own fleet
  | 'completed'        // the child says it finished
  | 'cancel-pending'   // asked to stop; not yet confirmed
  | 'cancelled';       // the child confirmed it stopped

export interface GroupUpgradeCounts {
  pending: number;
  updated: number;
  failed: number;
  skipped: number;
}

export interface GroupUpgradeRow {
  label: string;
  /** Muted styling for a row whose work is over. */
  settled: boolean;
  /** True only while the parent genuinely does not know. */
  awaiting: boolean;
  summary: string;
}

const LABELS: Record<GroupTargetState, string> = {
  'pending': 'Not started',
  'running': 'Upgrading',
  'completed': 'Done',
  'cancel-pending': 'Stopping…',
  'cancelled': 'Stopped',
};

export function groupUpgradeRow(
  state: string | null | undefined,
  counts?: Partial<GroupUpgradeCounts> | null,
): GroupUpgradeRow {
  const s = (state ?? 'pending') as GroupTargetState;
  const label = LABELS[s] ?? String(state);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  // A hub that has never answered has no counts to show, and inventing zeroes
  // for it would read as "nothing to do" rather than "we have not heard".
  if (!counts) {
    return {
      label,
      settled: s === 'completed' || s === 'cancelled',
      awaiting: s === 'pending' || s === 'cancel-pending',
      summary: s === 'pending' ? 'no report yet' : '—',
    };
  }

  const updated = n(counts.updated);
  const failed = n(counts.failed);
  const skipped = n(counts.skipped);
  const pending = n(counts.pending);
  const parts = [`${updated} updated`];
  if (pending) parts.push(`${pending} to go`);
  if (failed) parts.push(`${failed} failed`);
  // Skips are shown even at zero on a finished row: "0 skipped" is a fact an
  // admin checking a rollout wants stated, not inferred from an absence.
  if (skipped || s === 'completed' || s === 'cancelled') parts.push(`${skipped} skipped`);

  return {
    label,
    settled: s === 'completed' || s === 'cancelled',
    awaiting: s === 'cancel-pending',
    summary: parts.join(' · '),
  };
}
