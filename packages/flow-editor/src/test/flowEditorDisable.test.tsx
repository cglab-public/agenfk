/**
 * @vitest-environment jsdom
 *
 * CGLAB-428 — the editor hands its host's choice to the step dialog: only a
 * host that passes `canDisableChecks` (the hub admin) gets the switches. A
 * check switched off there is saved with the step, and counts as a change.
 */
import { render, screen, fireEvent, waitFor, cleanup, within, configure } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { FlowEditorModal } from '../FlowEditorModal';
import type { Flow, FlowClient, FlowStep, RegistryClient } from '../types';

const s = (name: string, order: number, extra: Partial<FlowStep> = {}): FlowStep => ({ id: `id-${name}`, name, label: name, order, ...extra });
const flowOf = (steps: FlowStep[]): Flow => ({ id: 'f1', name: 'My flow', steps, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const good = () => flowOf([
  s('TODO', 0, { isAnchor: true }),
  s('SPECS', 1, { role: 'test-authoring' }),
  s('BUILD', 2, { role: 'coding', checks: [{ id: 'human-approval' }] }),
  s('DONE', 3, { isAnchor: true }),
]);
const orphan = () => flowOf([
  s('TODO', 0, { isAnchor: true }),
  s('BUILD', 1, { checks: [{ id: 'red-set-passes-by-name' }] }),
  s('DONE', 2, { isAnchor: true }),
]);

function mount(flow: Flow, contract = true, extra: Record<string, unknown> = {}, contractDelayMs = 0) {
  const onClose = vi.fn();
  const updateFlow = vi.fn(async (_id: string, payload: Partial<Flow>) => ({ ...flow, ...payload } as Flow));
  const flowClient: FlowClient = {
    listFlows: async () => [flow],
    getDefaultFlow: async () => ({ ...flowOf([]), id: 'default', name: 'Default' }),
    createFlow: async p => ({ ...flow, ...p } as Flow),
    updateFlow,
    deleteFlow: async () => {},
    setProjectFlow: async () => {},
    ...(contract ? { getFlowContract: vi.fn(async (steps: FlowStep[]) => {
      if (contractDelayMs) await new Promise(r => setTimeout(r, contractDelayMs));
      return describeFlowContract(steps) as any;
    }) } : {}),
  };
  const registryClient: RegistryClient = { browseRegistry: async () => [], installFromRegistry: async () => flow };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FlowEditorModal isOpen onClose={onClose} projectId="p1" initialFlowId="f1" flowClient={flowClient} registryClient={registryClient} {...extra} />
    </QueryClientProvider>,
  );
  return { updateFlow, onClose, flowClient };
}
/** The flow has loaded (until then the panel shows a blank new flow) and its contract has arrived. */
const ready = async () => {
  await waitFor(() => expect(screen.getAllByDisplayValue('BUILD').length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByTestId('step-contract-btn-1')).toBeTruthy());
};
afterEach(() => cleanup());
// Every test here waits for the server's contract, which the editor asks for
// after a 250ms debounce. Testing Library's 1s default left a loaded 2-vCPU CI
// runner no margin, and a CI run failed on it; a real hang still fails at 5s.
configure({ asyncUtilTimeout: 5000 });


/** Opens BUILD's dialog once the server's contract has described it (its role's checks are listed). */
const openBuild = async () => {
  const btn = await screen.findByTestId('step-contract-btn-2');
  await waitFor(() => expect(btn.textContent).toMatch(/Implementing/));
  fireEvent.click(btn);
  const panel = await screen.findByTestId('step-contract');
  await within(panel).findByTestId('contract-builtins');
  return panel;
};

describe('flow editor: switching checks off (CGLAB-428)', () => {
  it('gives the step dialog no switches unless the host allows them', async () => {
    mount(good());
    await ready();
    const panel = await openBuild();
    expect(within(panel).queryByRole('button', { name: /switch off/i })).toBeNull();
  });

  it('saves a check the hub admin switched off with its step', async () => {
    const { updateFlow } = mount(good(), true, { canDisableChecks: true });
    await ready();
    const panel = await openBuild();
    fireEvent.click(within(panel).getByRole('button', { name: 'Switch off: Whole test suite passes' }));
    fireEvent.click(screen.getByRole('button', { name: /close step checks/i }));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    const build = (updateFlow.mock.calls[0][1].steps as FlowStep[]).find(x => x.name === 'BUILD')!;
    expect(build.disabledChecks).toEqual(['suite-green']);
  });

  it('a check switched off alone makes the flow dirty', async () => {
    mount(good(), true, { canDisableChecks: true });
    await ready();
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(screen.getByTestId('save-flow-btn').textContent).toMatch(/saved/i));
    const panel = await openBuild();
    fireEvent.click(within(panel).getByRole('button', { name: 'Switch off: Whole test suite passes' }));
    fireEvent.click(screen.getByRole('button', { name: /close step checks/i }));
    expect(screen.getByTestId('save-flow-btn').textContent).not.toMatch(/saved/i);
  });

  it("counts only the checks that will run on the step's button", async () => {
    mount(flowOf(good().steps.map(st => (st.name === 'BUILD' ? { ...st, disabledChecks: ['suite-green'] } : st))), true, { canDisableChecks: true });
    await ready();
    const on = describeFlowContract(good().steps).steps[2].onLeave.filter((c: any) => c.applicable && c.severity === 'block').length;
    const btn = await screen.findByTestId('step-contract-btn-2');
    await waitFor(() => expect(btn.textContent).toMatch(new RegExp(`(^|\\D)${on - 1} checks?$`)));
  });
});
