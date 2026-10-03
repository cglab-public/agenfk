/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T3) — the hub admin's flow editor round-trips step roles and
 * checks through the hub's admin API, with the contract from the hub's route.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { AdminFlows } from '../pages/AdminFlows';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

const steps = [
  { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 's1', name: 'SPECS', label: 'Specs', order: 1, role: 'test-authoring' },
  { id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
];
const FLOW = {
  id: 'f1', name: 'Org TDD', source: 'hub', version: 1, orgAvailable: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  definition: { name: 'Org TDD', steps },
};

beforeEach(() => {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/v1/admin/flows') return { data: [FLOW] } as never;
    if (url === '/v1/admin/flows/default') return { data: { id: 'default', name: 'Default Flow', steps: [] } } as never;
    if (url === '/v1/admin/flow-assignments') return { data: [] } as never;
    if (url === '/v1/admin/registry-config') return { data: { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null } } as never;
    if (url === '/v1/admin/registry/flows') return { data: [] } as never;
    return { data: {} } as never;
  });
  vi.mocked(api.post).mockImplementation(async (url: string, body: any) => {
    if (url === '/v1/admin/flows/contract') return { data: describeFlowContract(body.steps) } as never;
    return { data: {} } as never;
  });
  vi.mocked(api.put).mockImplementation(async (_url: string, body: any) => ({ data: { ...FLOW, definition: body.definition } }) as never);
});
afterEach(() => cleanup());

describe('hub flow editor: roles and checks round-trip', () => {
  it("sends the role the admin picked in the flow's definition", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><ThemeProvider><AdminFlows /></ThemeProvider></QueryClientProvider>);
    await waitFor(() => screen.getByTestId('admin-flows-new-btn'));
    fireEvent.click(screen.getByTestId('admin-flows-new-btn'));
    await waitFor(() => screen.getByTestId('flow-item-f1'));
    fireEvent.click(screen.getByTestId('flow-item-f1'));
    await waitFor(() => expect(screen.getByTestId('step-contract-btn-1').textContent).toMatch(/Writing tests/));
    fireEvent.click(screen.getByTestId('step-contract-btn-1'));
    const panel = await screen.findByTestId('step-contract');
    fireEvent.click(within(panel).getByRole('button', { name: /change role/i }));
    fireEvent.click(within(panel).getByRole('button', { name: /^Planning/ }));
    fireEvent.click(screen.getByRole('button', { name: /close step checks/i }));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/v1/admin/flows/f1', expect.anything()));
    const sent = vi.mocked(api.put).mock.calls.find(c => c[0] === '/v1/admin/flows/f1')![1] as any;
    expect(sent.definition.steps.find((s: any) => s.name === 'SPECS').role).toBe('planning');
  });
});
