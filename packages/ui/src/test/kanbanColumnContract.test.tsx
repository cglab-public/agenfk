/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T3) — the board's column headers carry the step contract,
 * with the check count the server resolves for the active flow.
 */
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { KanbanBoard } from '../components/KanbanBoard';
import { ActiveProjectProvider } from '../ActiveProject';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
});

const FLOW = {
  id: 'f1', name: 'Gated',
  steps: [
    { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 'b', name: 'SPECS', label: 'Specs', order: 1, role: 'test-authoring' },
    { id: 'c', name: 'PLAN', label: 'Plan', order: 2, role: 'planning', checks: [{ id: 'human-approval' }] },
    { id: 'd', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(() => Promise.resolve([{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }])),
    listItems: vi.fn(() => Promise.resolve([])),
    getItem: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
    getFlowContract: vi.fn(),
  },
}));

beforeEach(() => {
  localStorage.setItem('agenfk_project_id', 'p1');
  vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as never);
  vi.mocked(api.getFlowContract).mockImplementation(async (steps: unknown[]) => describeFlowContract(steps));
});
afterEach(() => { cleanup(); localStorage.clear(); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={qc}><ActiveProjectProvider><ThemeProvider><KanbanBoard /></ThemeProvider></ActiveProjectProvider></QueryClientProvider>);
}

describe('board column contracts', () => {
  it("shows each column's role, check count and approval", async () => {
    mount();
    const specs = await screen.findByTestId('column-header-SPECS');
    await waitFor(() => expect(within(specs).getByText('Writing tests')).toBeTruthy());
    // b13f37e6: the role is the line directly under the step name, not a badge beside it.
    const role = within(specs).getByText('Writing tests');
    expect(role.previousElementSibling?.tagName).toBe('H2');
    expect(role.previousElementSibling?.textContent).toMatch(/Specs/i);
    await waitFor(() => expect(within(specs).getByText(/\d+ checks/)).toBeTruthy());
    const plan = screen.getByTestId('column-header-PLAN');
    expect(within(plan).getByLabelText(/a person must approve/i)).toBeTruthy();
  });

  it('a flow from before roles shows no badges: its universal checks only warn', async () => {
    vi.mocked(api.getProjectFlow).mockResolvedValue({ ...FLOW, steps: FLOW.steps.map(({ role: _r, checks: _c, ...s }: any) => s) } as never);
    mount();
    const specs = await screen.findByTestId('column-header-SPECS');
    await waitFor(() => expect(api.getFlowContract).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
    expect(within(specs).queryByText(/checks?/)).toBeNull();
  });

  it('an older server without the contract route still shows the role and the approval', async () => {
    vi.mocked(api.getFlowContract).mockRejectedValue(new Error('404'));
    mount();
    const plan = await screen.findByTestId('column-header-PLAN');
    await waitFor(() => expect(within(plan).getByText('Planning')).toBeTruthy());
    expect(within(plan).getByLabelText(/a person must approve/i)).toBeTruthy();
    expect(within(plan).queryByText(/checks/)).toBeNull();
  });
});
