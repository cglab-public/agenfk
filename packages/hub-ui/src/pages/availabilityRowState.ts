/**
 * Decides the UI state of the per-flow "Available to org" toggle in the admin
 * Assignments panel.
 *
 * A flow appears in the org-flow picker iff `flows.org_available = 1` on the
 * hub. That flag is SEPARATE from the org-default assignment, but the two are
 * coupled: setting a flow as the org default forces it available, and the
 * selection endpoint refuses a non-available flow. So the org default is always
 * treated as available and its availability cannot be toggled off here — the
 * flow must first be un-defaulted.
 */
export interface AvailabilityRowState {
  /** Whether the flow is currently available in the org picker. */
  available: boolean;
  /** True when the toggle action is disabled (org default forces availability on). */
  locked: boolean;
  /** Value the action would set availability to (ignored when locked). */
  nextAvailable: boolean;
  /** Button label, or null when there is no action (locked). */
  actionLabel: string | null;
  /** Human-readable description of the current state. */
  hint: string;
}

export function availabilityRowState(orgAvailable: boolean, isOrgDefault: boolean): AvailabilityRowState {
  if (isOrgDefault) {
    return {
      available: true,
      locked: true,
      nextAvailable: true,
      actionLabel: null,
      hint: 'Available — required while this flow is the org default.',
    };
  }
  return {
    available: orgAvailable,
    locked: false,
    nextAvailable: !orgAvailable,
    actionLabel: orgAvailable ? 'Remove from picker' : 'Make available',
    hint: orgAvailable
      ? 'Available in the org flow picker.'
      : 'Not available in the org flow picker.',
  };
}
