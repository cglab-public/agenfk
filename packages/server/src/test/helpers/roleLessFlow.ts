/**
 * The default flow as it was before CGLAB-381 gave it roles.
 *
 * DEFAULT_FLOW now enforces checks (suite-green on leaving IN_PROGRESS, an
 * independent review on leaving REVIEW). Tests of verify MECHANICS that are
 * not about checks - failure diagnostics, worktree roots, async runs, log
 * files - bind their project to this copy so they keep testing what their
 * names say. What the default flow enforces is tested where checks are.
 */
import { DEFAULT_FLOW } from '@agenfk/core';

const NAME = 'Default Flow (no roles, test fixture)';

export async function bindRoleLessDefaultFlow(storage: any, projectId: string): Promise<string> {
  let flow = (await storage.listFlows()).find((f: any) => f.name === NAME);
  if (!flow) {
    flow = await storage.createFlow({
      id: `role-less-default-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: NAME,
      steps: DEFAULT_FLOW.steps.map(({ role: _r, checks: _c, ...st }: any) => ({ ...st })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  await storage.updateProject(projectId, { flowId: flow.id } as any);
  return flow.id;
}
