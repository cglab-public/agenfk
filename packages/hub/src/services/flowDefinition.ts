import { flowChecksErrors } from '@agenfk/core';

/**
 * Is this a usable flow definition?
 *
 * Mirrors core's `Flow` contract: a name, and a non-empty `steps[]` whose
 * entries each carry an id, a name and a numeric order.
 *
 * Shared because there are two callers with the same need and different
 * trust levels. `POST /v1/admin/flows` checks an admin's own input; the
 * federation fan-in checks what a PARENT HUB sent, which is a different hub
 * and therefore a trust boundary. The child half used to check only
 * `typeof definition === 'object'` — and `typeof [] === 'object'`, so an empty
 * object or an array installed cleanly and went out to every installation in
 * the org as a flow with no steps.
 */
export function invalidFlowDefinition(def: unknown): string | null {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return 'definition must be an object';
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string' || !d.name.trim()) return 'definition.name is required';
  if (!Array.isArray(d.steps) || d.steps.length === 0) return 'definition.steps must be a non-empty array';
  for (const s of d.steps) {
    if (!s || typeof s !== 'object') return 'each step must be an object';
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || !step.id) return 'each step requires an id';
    if (typeof step.name !== 'string' || !step.name) return 'each step requires a name';
    if (typeof step.order !== 'number') return 'each step requires a numeric order';
  }
  // CGLAB-380: step roles and checks, validated as a local server would.
  const contractErrors = flowChecksErrors(d.steps);
  return contractErrors.length ? contractErrors.join(' ') : null;
}
