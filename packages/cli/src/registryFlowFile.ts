/**
 * CGLAB-385 — a registry flow file as the local server takes it. The step
 * contract (role, checks), the anchors and the step's look travel with it:
 * dropping them installed a flow that enforced nothing its author wrote.
 */
import { stepContractFields } from '@agenfk/core';

export function registryFlowToLocal(parsed: any, newId: () => string) {
  return {
    name: parsed.name,
    description: parsed.description,
    steps: (Array.isArray(parsed.steps) ? parsed.steps : []).map((s: any) => ({
      id: newId(),
      name: s.name,
      label: s.label,
      order: s.order,
      isSpecial: s.isSpecial || false,
      ...(s.isAnchor ? { isAnchor: true } : {}),
      exitCriteria: s.exitCriteria || undefined,
      ...(typeof s.color === 'string' ? { color: s.color } : {}),
      ...(typeof s.icon === 'string' ? { icon: s.icon } : {}),
      ...stepContractFields(s),
    })),
  };
}
