/**
 * @vitest-environment jsdom
 *
 * Admin → Flows, the flow editor's footer.
 *
 * The label strings are pinned in adminFlowRegistry.test.ts, but a correct
 * constant that never reaches the button is the same bug as a wrong one — the
 * admin still sees "Save" / "Use this Flow" and still reads three CTAs as one
 * pipeline. These are the wiring tests the unit test cannot do:
 *  - the hub's captions actually render in the shared editor's footer;
 *  - the registry-config form's Save is not also called "Save";
 *  - Publish is absent, because the hub has no publish path.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminFlows } from '../pages/AdminFlows';
import { EDITOR_LABELS_HUB, PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const FLOW = {
  id: 'f1',
  name: 'TDD Flow',
  description: 'org flow',
  source: 'hub',
  version: 7,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  orgAvailable: true,
  definition: {
    name: 'TDD Flow',
    description: 'org flow',
    steps: [
      { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
      { id: 's1', name: 'DISCOVERY', label: 'Discovery', order: 1 },
      { id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
    ],
  },
};

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider><AdminFlows /></ThemeProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/flows') return { data: [FLOW] };
    if (url === '/v1/admin/flows/default') return { data: { id: 'default', name: 'Default Flow', steps: [] } };
    if (url === '/v1/admin/flow-assignments') return { data: [] };
    if (url === '/v1/admin/registry-config') {
      return { data: { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null } };
    }
    if (url === '/v1/admin/registry/flows') return { data: [] };
    return { data: {} };
  });
});

afterEach(() => { cleanup(); });

const openEditor = async () => {
  renderPage();
  await waitFor(() => screen.getByTestId('admin-flows-new-btn'));
  fireEvent.click(screen.getByTestId('admin-flows-new-btn'));
  await waitFor(() => screen.getByTestId('flow-editor-modal'));
  // The footer belongs to the editor PANEL, which only renders once a flow is
  // selected — opening the modal alone leaves the empty-state placeholder.
  await waitFor(() => screen.getByTestId('flow-item-f1'));
  fireEvent.click(screen.getByTestId('flow-item-f1'));
  await waitFor(() => screen.getByTestId('flow-footer'));
};

describe('Admin → Flows editor footer (hub host)', () => {
  it('renders the hub captions, not the standalone editor defaults', async () => {
    await openEditor();
    await waitFor(() => screen.getByTestId('flow-footer'));

    const save = screen.getByTestId('save-flow-btn');
    expect(save.textContent).toBe(EDITOR_LABELS_HUB.save);
    // Regression guard for the whole point of the change: the bare word must
    // not be what the admin sees.
    expect(save.textContent).not.toBe('Save');

    const use = screen.getByTestId('use-flow-btn');
    expect(use.textContent).toBe(EDITOR_LABELS_HUB.useFlow);
    expect(use.textContent).not.toBe('Use this Flow');
  });

  it('does not render a Publish button — the hub has no publish path', async () => {
    await openEditor();
    await waitFor(() => screen.getByTestId('flow-footer'));

    expect(screen.queryByTestId('publish-flow-btn')).toBeNull();
  });

  it('labels the registry-config form distinctly from the editor save', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-registry-save'));

    expect(screen.getByTestId('admin-registry-save').textContent).toBe('Save registry repo');
  });
});
