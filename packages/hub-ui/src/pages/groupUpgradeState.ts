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

/**
 * Whether the board still has something to wait for, and so should keep
 * refreshing.
 *
 * A dispatch with NO targets counts as live, not settled. Under scope 'all' a
 * hub appears only once it polls, so an empty list is the first seconds of
 * every group upgrade — treating it as finished froze the board on "nobody has
 * picked this up yet" and it never updated when they did.
 */
export function groupUpgradesLive(
  dispatches: ReadonlyArray<{ targets: ReadonlyArray<{ state: string }> }>,
): boolean {
  return dispatches.some(d =>
    d.targets.length === 0 || d.targets.some(t => !groupUpgradeRow(t.state, null).settled),
  );
}

export type GroupUpgradeRequest = {
  targetVersion: string;
  scope: 'all' | 'selected';
  childHubIds?: string[];
  confirmDowngrade?: true;
};

/**
 * The request the group-upgrade form sends (CGLAB-360). Mirrors
 * flowDispatchBody: 'all' carries no ids so a hub that joins later is covered,
 * 'selected' with nothing ticked is refused here rather than by the server.
 * `confirmDowngrade` is present only when true — the server reads `=== true`
 * and the audit row should not say "false" for an admin who never saw the box.
 * The parent cannot compute a child's downgrades, so this is the admin's
 * explicit word, not a computed warning.
 */
export function groupUpgradeBody(
  targetVersion: string,
  mode: 'all' | 'selected',
  selected: ReadonlySet<string>,
  confirmDowngrade: boolean,
): { ok: true; body: GroupUpgradeRequest } | { ok: false; error: string } {
  if (!targetVersion) return { ok: false, error: 'Pick a version.' };
  const body: GroupUpgradeRequest = { targetVersion, scope: 'all' };
  if (mode === 'selected') {
    const childHubIds = Array.from(selected);
    if (childHubIds.length === 0) return { ok: false, error: 'Pick at least one child hub, or choose All.' };
    body.scope = 'selected';
    body.childHubIds = childHubIds;
  }
  if (confirmDowngrade) body.confirmDowngrade = true;
  return { ok: true, body };
}
