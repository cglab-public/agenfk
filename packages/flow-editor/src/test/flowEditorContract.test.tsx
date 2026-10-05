/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T2) — the flow editor with a host that can describe a flow's
 * contract: each step shows its role, checks and approval at a glance, opens
 * into the step panel, and the flow cannot be saved while the server reports
 * a problem, with a one-click fix where there is one. A host without the
 * contract route (an older server) sees the editor exactly as before.
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

const column = async (index: number) => within(await screen.findByTestId(`step-row-${index}`));

describe('flow editor: contracts', () => {
  it('a host without the contract route shows the editor as before', async () => {
    mount(good(), false);
    await screen.findByTestId('step-row-1');
    expect(screen.queryByTestId('step-contract-btn-1')).toBeNull();
    expect(screen.queryByText(/start from template/i)).toBeNull();
  });

  it("shows each step's role, check count and approval at a glance", async () => {
    mount(good());
    await ready();
    const btn = await screen.findByTestId('step-contract-btn-2');
    await waitFor(() => expect(btn.textContent).toMatch(/Implementing/));
    expect(btn.textContent).toMatch(/\d+ checks?/);
    expect(within(btn).getByLabelText(/a person approves/i)).toBeTruthy();
    expect((await column(1)).getByTestId('step-contract-btn-1').textContent).toMatch(/Writing tests/);
  });

  it('opens a step, changes its role, and saves it', async () => {
    const { updateFlow } = mount(good());
    await ready();
    fireEvent.click(await screen.findByTestId('step-contract-btn-2'));
    const panel = await screen.findByTestId('step-contract');
    fireEvent.click(within(panel).getByRole('button', { name: /change role/i }));
    fireEvent.click(within(panel).getByRole('button', { name: /^Review/ }));
    fireEvent.click(screen.getByRole('button', { name: /close step checks/i }));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    const build = (updateFlow.mock.calls[0][1].steps as FlowStep[]).find(x => x.name === 'BUILD')!;
    expect(build.role).toBe('review');
  });

  it('closes the step dialog with Escape', async () => {
    mount(good());
    await ready();
    fireEvent.click(screen.getByTestId('step-contract-btn-2'));
    const dialog = await screen.findByRole('dialog', { name: /checks for build/i });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /checks for build/i })).toBeNull();
  });

  it("a flow the org hub owns shows its contract read-only, saying who sets it", async () => {
    mount({ ...good(), source: 'hub' }, true, { hubManagedReadOnly: true });
    await ready();
    fireEvent.click(screen.getByTestId('step-contract-btn-2'));
    const dialog = await screen.findByRole('dialog', { name: /checks for build/i });
    expect(dialog.textContent).toMatch(/set by your org admin/i);
    expect(within(dialog).queryByRole('button', { name: /change role/i })).toBeNull();
  });

  it("shows where each record is made and used", async () => {
    mount(good());
    await ready();
    const lane = await screen.findByTestId('records-lane');
    await waitFor(() => expect(lane.textContent).toMatch(/Failing-test list/));
    expect(lane.textContent).toMatch(/SPECS/);
    expect(lane.textContent).toMatch(/BUILD/);
  });

  it('cannot save while the server reports a problem, and says it in words', async () => {
    mount(orphan());
    await ready();
    const problems = await screen.findByTestId('flow-contract-problems');
    await waitFor(() => expect(problems.textContent).toMatch(/failing tests now pass/i));
    expect(problems.textContent).toMatch(/Failing-test list/);
    expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('fixes it in one click by removing the check', async () => {
    mount(orphan());
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: /remove this check/i }));
    await waitFor(() => expect(screen.queryByTestId('flow-contract-problems')).toBeNull());
    expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('still works when the contract answer is slow, as on a loaded CI runner', async () => {
    // The editor asks after a 250ms debounce and a slow runner adds the rest:
    // a CI run failed the test above this way (1s was the whole budget).
    mount(orphan(), true, {}, 1200);
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: /remove this check/i }));
    await waitFor(() => expect(screen.queryByTestId('flow-contract-problems')).toBeNull());
  });

  it('or by adding a Writing-tests step before it', async () => {
    const { updateFlow } = mount(orphan());
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: /add a .writing tests. step before/i }));
    await waitFor(() => expect(screen.queryByTestId('flow-contract-problems')).toBeNull());
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    const steps = updateFlow.mock.calls[0][1].steps as FlowStep[];
    const i = steps.findIndex(x => x.name === 'BUILD');
    expect(steps[i - 1].role).toBe('test-authoring');
  });

  it('a change to a role alone makes the flow dirty', async () => {
    mount(good());
    await ready();
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(screen.getByTestId('save-flow-btn').textContent).toMatch(/saved/i));
    fireEvent.click(screen.getByTestId('step-contract-btn-1'));
    const panel = await screen.findByTestId('step-contract');
    fireEvent.click(within(panel).getByRole('button', { name: /change role/i }));
    fireEvent.click(within(panel).getByRole('button', { name: /no role/i }));
    fireEvent.click(screen.getByRole('button', { name: /close step checks/i }));
    expect(screen.getByTestId('save-flow-btn').textContent).not.toMatch(/saved/i);
  });

  it('Escape after a pick closes only the step dialog, never the editor', async () => {
    const { onClose } = mount(good());
    await ready();
    fireEvent.click(screen.getByTestId('step-contract-btn-2'));
    const panel = await screen.findByTestId('step-contract');
    fireEvent.click(within(panel).getByRole('button', { name: /change role/i }));
    fireEvent.click(within(panel).getByRole('button', { name: /^Review/ }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /checks for build/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends the commit flags with the contract question, so an auto commit that would do nothing is reported (S10 review)', async () => {
    const { flowClient } = mount(flowOf([
      s('TODO', 0, { isAnchor: true }),
      s('BUILD', 1, { autoCommit: true } as Partial<FlowStep>),
      s('DONE', 2, { isAnchor: true }),
    ]));
    await ready();
    const problems = await screen.findByTestId('flow-contract-problems');
    await waitFor(() => expect(problems.textContent).toMatch(/auto commit has no effect/i));
    const sent = (flowClient.getFlowContract as any).mock.calls.at(-1)[0];
    expect(sent.find((st: FlowStep) => st.name === 'BUILD')).toMatchObject({ autoCommit: true });
  });

  it('does not ask the server again for a label edit, which the contract does not read', async () => {
    const { flowClient } = mount(good());
    await ready();
    await new Promise(r => setTimeout(r, 400)); // the loaded flow's own (debounced) request settles first
    const before = (flowClient.getFlowContract as any).mock.calls.length;
    fireEvent.change(screen.getAllByPlaceholderText('e.g. In Progress')[1], { target: { value: 'Build it' } });
    await new Promise(r => setTimeout(r, 400));
    expect((flowClient.getFlowContract as any).mock.calls.length).toBe(before);
  });

  it('starts from a template in one click', async () => {
    const { updateFlow } = mount(good());
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: /start from template/i }));
    fireEvent.click(screen.getByRole('button', { name: /^TDD/ }));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    const steps = updateFlow.mock.calls[0][1].steps as FlowStep[];
    expect(steps.map(x => x.name)).toContain('CREATE_UNIT_TESTS');
    expect(steps.find(x => x.name === 'REFACTOR')!.role).toBe('refactoring');
  });
});

/**
 * 281adef0 — where the flow runs the project's suite: at every card's final
 * step (the default) or once, at the top-level card. A flow-level toggle.
 */
describe('flow editor: verifyAt', () => {
  it('shows the flow\'s setting and saves a change', async () => {
    const { updateFlow } = mount(good());
    await ready();
    const toggle = screen.getByTestId('flow-verify-at-parent') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    expect(updateFlow.mock.calls[0][1].verifyAt).toBe('parent');
  });

  it('loads a flow that already verifies at the parent as checked, and unchecking saves leaf', async () => {
    const { updateFlow } = mount({ ...good(), verifyAt: 'parent' });
    await ready();
    const toggle = screen.getByTestId('flow-verify-at-parent') as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(updateFlow).toHaveBeenCalled());
    expect(updateFlow.mock.calls[0][1].verifyAt).toBe('leaf');
  });
});
