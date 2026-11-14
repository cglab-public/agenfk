// What the admin pages call their states. The API keeps its own words
// (`in_progress`, `directive`); these are what an admin reads.
export type UpgradeState = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled';

const UPGRADE_STATE: Record<UpgradeState, string> = {
  pending: 'Waiting',
  in_progress: 'Running',
  // 'Updated', not 'Upgraded': an admin may deliberately roll a fleet back.
  succeeded: 'Updated',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** An upgrade target's state, in plain words. */
export const upgradeStateLabel = (s: UpgradeState): string => UPGRADE_STATE[s] ?? s;

/** "2 waiting": a count of targets in a state, for the summary chips. */
export const upgradeStateCount = (s: UpgradeState, n: number): string => `${n} ${UPGRADE_STATE[s].toLowerCase()}`;
