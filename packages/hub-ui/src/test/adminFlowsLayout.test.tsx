/**
 * @vitest-environment jsdom
 *
 * [UX] Split the Flows admin page: the flow list (with its assignments and
 * child-hub dispatches) and the registry (repo settings and pull requests)
 * were five jobs in one scroll. They are two tabs now, the tab survives a
 * reload through the URL hash, the create button fits on one line, repo
 * overrides read as the URL they are, and the header states the precedence
 * the hub actually applies.
 */
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminFlows } from '../pages/AdminFlows';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const FLOW = {
  id: 'f1', name: 'TDD Flow', description: 'org flow', source: 'hub', version: 7,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', orgAvailable: true,
  definition: { name: 'TDD Flow', description: 'org flow', steps: [
    { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ] },
};
const REPO = 'github.com/Acme/API';

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider><AdminFlows /></ThemeProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  window.location.hash = '';
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/flows') return { data: [FLOW] };
    if (url === '/v1/admin/flows/default') return { data: { id: 'default', name: 'Default Flow', steps: [] } };
    if (url === '/v1/admin/flow-assignments') return { data: [{ scope: 'repo', targetId: REPO, flowId: 'f1', remoteUrl: REPO }] };
    if (url === '/v1/admin/registry-config') {
      return { data: { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null } };
    }
    if (url === '/v1/admin/registry/flows') return { data: [] };
    if (url === '/v1/admin/registry/pulls') return { data: { pulls: [] } };
    return { data: {} };
  });
});
afterEach(() => { cleanup(); window.location.hash = ''; });

describe('Flows admin page', () => {
  it('opens on the Flows tab, with the registry out of the way', async () => {
    renderPage();
    const tabs = screen.getByRole('tablist', { name: 'Flows sections' });
    expect(within(tabs).getAllByRole('tab').map(t => t.textContent?.trim())).toEqual(['Flows', 'Registry']);
    expect(within(tabs).getByRole('tab', { name: 'Flows' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('TDD Flow')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-registry-save')).toBeNull();
  });

  it('shows the registry on its own tab, and remembers it in the URL', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Registry' }));
    expect(screen.getByRole('tab', { name: 'Registry' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('admin-registry-save')).toBeInTheDocument();
    expect(await screen.findByTestId('admin-registry-pulls')).toBeInTheDocument();
    expect(screen.queryByText('TDD Flow')).toBeNull();
    expect(window.location.hash).toBe('#registry');
  });

  it('opens straight on the registry when the URL says so', async () => {
    window.location.hash = '#registry';
    renderPage();
    expect(screen.getByRole('tab', { name: 'Registry' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('admin-registry-save')).toBeInTheDocument();
  });

  it('names the create button in one short label', async () => {
    renderPage();
    expect(screen.getByTestId('admin-flows-new-btn')).toHaveTextContent(/^New flow$/);
  });

  it('states the precedence the hub applies', async () => {
    renderPage();
    expect(screen.getByText(/installation override, then a repo override, then the org default/i)).toBeInTheDocument();
    expect(screen.queryByText(/installation > project > org/)).toBeNull();
  });

  it('shows a repo override as the URL it is, in its real case', async () => {
    renderPage();
    const name = await screen.findByText('TDD Flow');
    fireEvent.click(name.closest('button') as HTMLElement);
    const url = await screen.findByText(REPO);
    expect(url.className).not.toMatch(/(?:^|\s)uppercase(?:\s|$)/);
    expect(url.className).toMatch(/(?:^|\s)font-mono(?:\s|$)/);
  });

  it('opens the flow editor from either tab', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Registry' }));
    fireEvent.click(screen.getByTestId('admin-flows-new-btn'));
    await waitFor(() => screen.getByTestId('flow-editor-modal'));
  });
});
