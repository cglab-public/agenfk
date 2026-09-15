/**
 * @vitest-environment jsdom
 *
 * Admin → Flows, with a flow the parent hub sent (CGLAB-182, task 3).
 *
 * The server is the control — it refuses the write whichever client asks. This
 * is the explanation: the admin must be able to see, before they click, that
 * this flow belongs to the parent and that leaving the group hands it back,
 * rather than discovering it as a 409 after drafting an edit.
 *
 * A correct constant that never reaches the button is the same bug as a wrong
 * one, which is why parentFlowLock's unit test is not enough on its own.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminFlows, flowClient } from '../pages/AdminFlows';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { PARENT_FLOW_LOCK_REASON } from '../pages/parentFlowLock';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const steps = [
  { id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
  { id: 's1', name: 'DONE', label: 'Done', order: 1, isAnchor: true },
];

// Same NAME, different origin — the clash the user chose to allow. The local
// one must stay editable, so a guard keyed on the name instead of the origin
// fails here.
const PARENT_FLOW = {
  id: 'f-parent', name: 'Group TDD', description: 'the org standard',
  source: 'parent', version: 3, orgAvailable: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  definition: { name: 'Group TDD', steps },
};
const LOCAL_FLOW = {
  id: 'f-local', name: 'Group TDD', description: 'ours',
  source: 'hub', version: 1, orgAvailable: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  definition: { name: 'Group TDD', steps },
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
    if (url === '/v1/admin/flows') return { data: [PARENT_FLOW, LOCAL_FLOW] };
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

const expand = async (flowId: string) => {
  renderPage();
  await waitFor(() => screen.getByTestId(`admin-flow-row-${flowId}`));
  fireEvent.click(screen.getByTestId(`admin-flow-row-${flowId}`));
  await waitFor(() => screen.getByTestId('admin-flow-edit-btn'));
};

describe('Admin → Flows: a flow the parent hub sent', () => {
  it('shows its origin in the list, so a shared name is not ambiguous', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-flow-row-f-parent'));
    expect(screen.getByTestId('admin-flow-row-f-parent').textContent).toMatch(/parent/i);
    expect(screen.getByTestId('admin-flow-row-f-local').textContent).not.toMatch(/parent/i);
  });

  it('disables Edit flow and says who owns it', async () => {
    await expand('f-parent');
    const edit = screen.getByTestId('admin-flow-edit-btn') as HTMLButtonElement;
    expect(edit).toBeDisabled();
    expect(screen.getByTestId('admin-flow-parent-lock').textContent).toMatch(/parent hub/i);
  });

  it('does not open the editor when the disabled Edit is clicked', async () => {
    await expand('f-parent');
    fireEvent.click(screen.getByTestId('admin-flow-edit-btn'));
    expect(screen.queryByTestId('flow-editor-modal')).toBeNull();
  });

  it('renders the shared lock reason, so the promise reaches the admin verbatim', async () => {
    await expand('f-parent');
    expect(screen.getByTestId('admin-flow-parent-lock').textContent).toBe(PARENT_FLOW_LOCK_REASON);
  });

  it('refuses a save or delete of a parent flow reached through the editor modal', async () => {
    // Disabling one button is not the control and is not even the whole
    // explanation: "New / Import" opens the shared FlowEditorModal, whose
    // sidebar lists EVERY flow and offers Save and Delete on whichever is
    // selected. The server refuses both, but the admin would get a raw 409
    // after drafting the edit — the exact thing parentFlowLock exists to
    // prevent. So the client refuses first, with the sentence.
    renderPage();
    await waitFor(() => screen.getByTestId('admin-flows-new-btn'));
    fireEvent.click(screen.getByTestId('admin-flows-new-btn'));
    await waitFor(() => screen.getByTestId('flow-editor-modal'));
    await waitFor(() => screen.getByTestId('flow-item-f-parent'));

    await expect(flowClient.updateFlow('f-parent', { name: 'x', steps } as any))
      .rejects.toThrow(PARENT_FLOW_LOCK_REASON);
    await expect(flowClient.deleteFlow('f-parent')).rejects.toThrow(PARENT_FLOW_LOCK_REASON);
    expect(api.put).not.toHaveBeenCalledWith('/v1/admin/flows/f-parent', expect.anything());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('still lets the editor save and delete the child\'s own flow', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-flows-new-btn'));
    fireEvent.click(screen.getByTestId('admin-flows-new-btn'));
    await waitFor(() => screen.getByTestId('flow-editor-modal'));
    await waitFor(() => screen.getByTestId('flow-item-f-local'));

    await flowClient.deleteFlow('f-local');
    expect(api.delete).toHaveBeenCalledWith('/v1/admin/flows/f-local');
  });

  it('still lets the child choose whether to offer it in the picker', async () => {
    // The definition is the parent's; which flows this hub offers its own
    // teams is not.
    await expand('f-parent');
    const avail = screen.getByTestId('admin-flow-toggle-availability') as HTMLButtonElement;
    expect(avail).not.toBeDisabled();
  });

  it('leaves the child\'s own same-named flow fully editable', async () => {
    await expand('f-local');
    expect(screen.getByTestId('admin-flow-edit-btn')).not.toBeDisabled();
    expect(screen.queryByTestId('admin-flow-parent-lock')).toBeNull();
  });
});
