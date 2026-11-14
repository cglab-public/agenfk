/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T3) — the Kanban UI's flow editor round-trips step roles and
 * checks through the local server's API: what the person picks is what is
 * sent, and the contract comes from the server's route.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { FlowEditorModal } from '../components/FlowEditorModal';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(() => Promise.resolve({ svg: '<svg />' })) } }));
vi.mock('../api', () => ({
  api: {
    createFlow: vi.fn(), updateFlow: vi.fn(), setProjectFlow: vi.fn(), deleteFlow: vi.fn(), listFlows: vi.fn(),
    getProjectFlow: vi.fn(), getDefaultFlow: vi.fn(), browseRegistry: vi.fn(), installFromRegistry: vi.fn(),
    publishToRegistry: vi.fn(), getOrgAvailableFlows: vi.fn(), getFlowContract: vi.fn(),
  },
}));

const FLOW = {
  id: 'f1', name: 'Mine',
  steps: [
    { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 'b', name: 'BUILD', label: 'Build', order: 1, role: 'coding' },
    { id: 'c', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(api.listFlows).mockResolvedValue([FLOW] as never);
  vi.mocked(api.getDefaultFlow).mockResolvedValue({ ...FLOW, id: 'default', name: 'Default' } as never);
  vi.mocked(api.getOrgAvailableFlows).mockResolvedValue([] as never);
  vi.mocked(api.browseRegistry).mockResolvedValue([] as never);
  vi.mocked(api.getFlowContract).mockImplementation(async (steps: unknown[]) => describeFlowContract(steps));
  vi.mocked(api.updateFlow).mockImplementation(async (_id: string, p: Record<string, unknown>) => ({ ...FLOW, ...p }) as never);
});
afterEach(() => cleanup());

describe('Kanban UI flow editor: roles and checks round-trip', () => {
  it('sends the role and the go-ahead the person set, through updateFlow', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<ThemeProvider><QueryClientProvider client={qc}><FlowEditorModal isOpen onClose={() => {}} projectId="p1" initialFlowId="f1" /></QueryClientProvider></ThemeProvider>);
    await waitFor(() => expect(screen.getByTestId('step-contract-btn-1').textContent).toMatch(/Implementing/));
    fireEvent.click(screen.getByTestId('step-contract-btn-1'));
    const panel = await screen.findByTestId('step-contract');
    fireEvent.click(within(panel).getByRole('checkbox', { name: /a person must approve/i }));
    fireEvent.click(screen.getByRole('button', { name: /close step checks/i }));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.updateFlow).toHaveBeenCalled());
    const build = (vi.mocked(api.updateFlow).mock.calls[0][1] as { steps: Array<{ name: string }> }).steps.find(s => s.name === 'BUILD');
    expect(build).toMatchObject({ role: 'coding', checks: [{ id: 'human-approval' }] });
    expect(api.getFlowContract).toHaveBeenCalled();
  });
});
