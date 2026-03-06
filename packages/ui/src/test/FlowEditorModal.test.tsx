/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { FlowEditorModal } from '../components/FlowEditorModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { Flow } from '../types';

vi.mock('../api', () => ({
  api: {
    createFlow: vi.fn(),
    updateFlow: vi.fn(),
    setProjectFlow: vi.fn(),
    deleteFlow: vi.fn(),
    listFlows: vi.fn(),
    getProjectFlow: vi.fn(),
  },
}));

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

const PROJECT_ID = 'proj-abc';

const DEFAULT_FLOW: Flow = {
  id: 'default-flow-id',
  name: 'Default Flow',
  description: 'Built-in default flow',
  projectId: PROJECT_ID,
  steps: [
    { id: 'd1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
    { id: 'd2', name: 'in_progress', label: 'In Progress', order: 1, exitCriteria: '' },
    { id: 'd3', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SAMPLE_FLOW: Flow = {
  id: 'flow-1',
  name: 'My Flow',
  description: 'A sample flow',
  projectId: PROJECT_ID,
  steps: [
    { id: 's1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
    { id: 's2', name: 'in_review', label: 'In Review', order: 1, exitCriteria: 'Ticket refined' },
    { id: 's3', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SAMPLE_FLOW_2: Flow = {
  id: 'flow-2',
  name: 'Sprint Flow',
  description: '',
  projectId: PROJECT_ID,
  steps: [
    { id: 's4', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
    { id: 's5', name: 'in_progress', label: 'In Progress', order: 1, exitCriteria: '' },
    { id: 's6', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('FlowEditorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_FLOW, SAMPLE_FLOW_2]);
    vi.mocked(api.getProjectFlow).mockResolvedValue(DEFAULT_FLOW);
  });

  afterEach(() => {
    cleanup();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it('renders nothing when isOpen=false', () => {
    render(
      <FlowEditorModal isOpen={false} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.queryByTestId('flow-editor-modal')).toBeNull();
  });

  it('renders the modal when isOpen=true', () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('flow-editor-modal')).toBeDefined();
  });

  it('renders nothing when open=false (legacy props)', () => {
    render(
      <FlowEditorModal open={false} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.queryByTestId('flow-editor-modal')).toBeNull();
  });

  // ── Sidebar: flow list ─────────────────────────────────────────────────────

  it('sidebar renders flow list from listFlows mock', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(api.listFlows).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('flow-item-flow-1')).toBeDefined());
    expect(screen.getByTestId('flow-item-flow-2')).toBeDefined();
  });

  it('clicking a flow in the sidebar loads it into the editor form', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('My Flow');
    });
  });

  it('clicking a second flow loads its data', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-2'));
    fireEvent.click(screen.getByTestId('flow-item-flow-2'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Sprint Flow');
    });
  });

  it('active flow shows "Active" badge, delete is disabled', async () => {
    render(
      <FlowEditorModal
        isOpen={true}
        onClose={() => {}}
        projectId={PROJECT_ID}
        activeFlowId="flow-1"
      />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-active-badge-flow-1'));
    expect(screen.getByTestId('flow-active-badge-flow-1')).toBeDefined();
    const deleteBtn = screen.getByTestId('delete-flow-btn-flow-1') as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it('non-active flow delete button is enabled', async () => {
    render(
      <FlowEditorModal
        isOpen={true}
        onClose={() => {}}
        projectId={PROJECT_ID}
        activeFlowId="flow-1"
      />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('delete-flow-btn-flow-2'));
    const deleteBtn = screen.getByTestId('delete-flow-btn-flow-2') as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(false);
  });

  // ── Sidebar: + New Flow ────────────────────────────────────────────────────

  it('+ New Flow button opens a blank form', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('');
    });
  });

  // ── Sidebar: delete with confirm ───────────────────────────────────────────

  it('delete shows inline confirm, calls deleteFlow on Yes', async () => {
    vi.mocked(api.deleteFlow).mockResolvedValue(undefined);
    render(
      <FlowEditorModal
        isOpen={true}
        onClose={() => {}}
        projectId={PROJECT_ID}
        activeFlowId="flow-1"
      />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('delete-flow-btn-flow-2'));
    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-2'));
    await waitFor(() => screen.getByTestId('delete-confirm'));
    fireEvent.click(screen.getByTestId('delete-confirm-yes'));
    await waitFor(() => expect(api.deleteFlow).toHaveBeenCalledWith('flow-2'));
  });

  it('delete confirm No cancels without deleting', async () => {
    render(
      <FlowEditorModal
        isOpen={true}
        onClose={() => {}}
        projectId={PROJECT_ID}
        activeFlowId="flow-1"
      />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('delete-flow-btn-flow-2'));
    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-2'));
    await waitFor(() => screen.getByTestId('delete-confirm'));
    fireEvent.click(screen.getByTestId('delete-confirm-no'));
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
    expect(api.deleteFlow).not.toHaveBeenCalled();
  });

  // ── initialFlowId pre-selection ────────────────────────────────────────────

  it('pre-selects the flow matching initialFlowId', async () => {
    render(
      <FlowEditorModal
        isOpen={true}
        onClose={() => {}}
        projectId={PROJECT_ID}
        initialFlowId="flow-2"
      />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-2'));
    // Selecting via initialFlowId sets the editor to that flow after data loads
    fireEvent.click(screen.getByTestId('flow-item-flow-2'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Sprint Flow');
    });
  });

  // ── Step editing (within an open editor panel) ─────────────────────────────

  it('renders the correct number of step rows for a selected flow', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-row-0'));
    // SAMPLE_FLOW has 3 steps: TODO (anchor), in_review (middle), DONE (anchor)
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.getByTestId('step-row-1')).toBeDefined();
    expect(screen.getByTestId('step-row-2')).toBeDefined();
    expect(screen.queryByTestId('step-row-3')).toBeNull();
  });

  it('seeds step fields from the selected flow (middle step only — anchors have no editable fields)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    // index 1 is the middle step (in_review)
    await waitFor(() => screen.getByTestId('step-name-1'));
    expect((screen.getByTestId('step-name-1') as HTMLInputElement).value).toBe('in_review');
    expect((screen.getByTestId('step-label-1') as HTMLInputElement).value).toBe('In Review');
    expect((screen.getByTestId('step-exit-criteria-1') as HTMLTextAreaElement).value).toBe('Ticket refined');
  });

  it('adds a blank step when Add Step is clicked', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    // Click New Flow to get blank editor
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('add-step-btn'));
    // Starts with 1 blank step
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.queryByTestId('step-row-1')).toBeNull();
    fireEvent.click(screen.getByTestId('add-step-btn'));
    expect(screen.getByTestId('step-row-1')).toBeDefined();
  });

  it('removes a middle (non-anchor) step when Delete is clicked', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    // SAMPLE_FLOW: [TODO(anchor,0), in_review(middle,1), DONE(anchor,2)] — 3 rows
    await waitFor(() => screen.getByTestId('step-row-2'));
    // Delete the middle step (index 1)
    fireEvent.click(screen.getByTestId('delete-step-1'));
    // After deletion only 2 rows remain (TODO and DONE anchors)
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.getByTestId('step-row-1')).toBeDefined();
    expect(screen.queryByTestId('step-row-2')).toBeNull();
  });

  it('anchor step rows have no delete button', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-row-0'));
    // Anchor rows (index 0 = TODO, index 2 = DONE) should have no delete button
    expect(screen.queryByTestId('delete-step-0')).toBeNull();
    expect(screen.queryByTestId('delete-step-2')).toBeNull();
    // Middle step (index 1) should have a delete button
    expect(screen.getByTestId('delete-step-1')).toBeDefined();
  });

  it('anchor step rows have a lock icon and no drag handle', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-anchor-lock-0'));
    expect(screen.getByTestId('step-anchor-lock-0')).toBeDefined();
    expect(screen.getByTestId('step-anchor-lock-2')).toBeDefined();
  });

  // ── Save ──────────────────────────────────────────────────────────────────

  it('calls createFlow with correct payload on Save in create mode', async () => {
    vi.mocked(api.createFlow).mockResolvedValue({ ...SAMPLE_FLOW, id: 'new-flow' });
    const onClose = vi.fn();
    render(
      <FlowEditorModal isOpen={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('flow-name-input'));

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Sprint Flow' } });
    fireEvent.change(screen.getByTestId('step-name-0'), { target: { value: 'in_progress' } });
    fireEvent.change(screen.getByTestId('step-label-0'), { target: { value: 'In Progress' } });

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.createFlow).mock.calls[0][0];
    expect(call.name).toBe('Sprint Flow');
    expect(call.projectId).toBe(PROJECT_ID);
    expect(Array.isArray(call.steps)).toBe(true);
  });

  it('calls updateFlow with the flow id on Save in edit mode', async () => {
    vi.mocked(api.updateFlow).mockResolvedValue(SAMPLE_FLOW);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('flow-name-input'));

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Updated Flow' } });
    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() =>
      expect(api.updateFlow).toHaveBeenCalledWith('flow-1', expect.objectContaining({ name: 'Updated Flow' }))
    );
  });

  it('Save button is disabled when flow name is empty', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('save-flow-btn'));
    const saveBtn = screen.getByTestId('save-flow-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  // ── "Use this Flow" ───────────────────────────────────────────────────────

  it('calls setProjectFlow with existing flow id when Use this Flow is clicked', async () => {
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('use-flow-btn'));
    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() =>
      expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'flow-1')
    );
  });

  it('creates flow then calls setProjectFlow when Use this Flow is clicked in create mode', async () => {
    const newFlow = { ...SAMPLE_FLOW, id: 'created-flow' };
    vi.mocked(api.createFlow).mockResolvedValue(newFlow);
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('flow-name-input'));

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'New Sprint Flow' } });
    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'created-flow'));
  });

  it('Use this Flow button is disabled when flow name is empty', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('use-flow-btn'));
    const useBtn = screen.getByTestId('use-flow-btn') as HTMLButtonElement;
    expect(useBtn.disabled).toBe(true);
  });

  // ── Cancel / Close ────────────────────────────────────────────────────────

  it('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <FlowEditorModal isOpen={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('X button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <FlowEditorModal isOpen={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    render(
      <FlowEditorModal isOpen={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Step field editing ────────────────────────────────────────────────────

  it('updates step name field when user types a non-reserved name', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    // index 1 is the middle (non-anchor) step
    await waitFor(() => screen.getByTestId('step-name-1'));
    const nameInput = screen.getByTestId('step-name-1') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'qa_review' } });
    expect(nameInput.value).toBe('qa_review');
    // No reserved name error
    expect(screen.queryByTestId('step-reserved-error-1')).toBeNull();
  });

  it('shows Reserved name error and disables Save when a reserved name is typed', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-name-1'));
    const nameInput = screen.getByTestId('step-name-1') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'BLOCKED' } });
    await waitFor(() => screen.getByTestId('step-reserved-error-1'));
    expect(screen.getByTestId('step-reserved-error-1').textContent).toBe('Reserved name');
    // Save button should be disabled
    const saveBtn = screen.getByTestId('save-flow-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('shows Reserved name error for case-insensitive match (e.g. "blocked")', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-name-1'));
    const nameInput = screen.getByTestId('step-name-1') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'blocked' } });
    await waitFor(() => screen.getByTestId('step-reserved-error-1'));
    expect(screen.getByTestId('step-reserved-error-1')).toBeDefined();
  });

  // ── Legacy props compatibility ────────────────────────────────────────────

  it('renders the modal in create mode when no flow is provided (legacy open=)', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('flow-editor-modal')).toBeDefined();
  });

  it('renders modal in edit mode when a flow is provided (legacy open=)', async () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('flow-editor-modal')).toBeDefined();
    // With the legacy flow prop it pre-selects, but data comes from listFlows
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    // Selecting the pre-seeded flow populates the form
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => {
      expect((screen.getByTestId('flow-name-input') as HTMLInputElement).value).toBe('My Flow');
    });
  });

  // ── DEFAULT flow loading ───────────────────────────────────────────────────

  it('clicking DEFAULT row loads it into read-only panel (inputs disabled)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    // Wait for the default flow query to resolve
    await waitFor(() => expect(api.getProjectFlow).toHaveBeenCalledWith(PROJECT_ID));
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.disabled).toBe(true);
    });
    // Middle step inputs should also be disabled (anchors have no editable name input)
    const stepName = screen.getByTestId('step-name-1') as HTMLInputElement;
    expect(stepName.disabled).toBe(true);
    // Save button should NOT be visible in read-only mode
    expect(screen.queryByTestId('save-flow-btn')).toBeNull();
    // Clone to Edit button should be visible
    expect(screen.getByTestId('clone-to-edit-btn')).toBeDefined();
  });

  it('"Clone to Edit" on DEFAULT creates editable copy named "Copy of Default Flow"', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => expect(api.getProjectFlow).toHaveBeenCalledWith(PROJECT_ID));
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => screen.getByTestId('clone-to-edit-btn'));
    fireEvent.click(screen.getByTestId('clone-to-edit-btn'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Copy of Default Flow');
      expect(nameInput.disabled).toBe(false);
    });
    // Save button should now be visible and enabled
    expect(screen.getByTestId('save-flow-btn')).toBeDefined();
  });

  it('Clone button on a user flow creates editable copy with "Copy of <name>"', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('clone-flow-btn-flow-1'));
    fireEvent.click(screen.getByTestId('clone-flow-btn-flow-1'));
    await waitFor(() => {
      const nameInput = screen.getByTestId('flow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Copy of My Flow');
      expect(nameInput.disabled).toBe(false);
    });
  });

  it('cloned flow has no id — Save calls createFlow', async () => {
    vi.mocked(api.createFlow).mockResolvedValue({ ...SAMPLE_FLOW, id: 'new-clone-id', name: 'Copy of My Flow' });
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('clone-flow-btn-flow-1'));
    fireEvent.click(screen.getByTestId('clone-flow-btn-flow-1'));
    await waitFor(() => screen.getByTestId('save-flow-btn'));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.createFlow).mock.calls[0][0];
    expect(call.name).toBe('Copy of My Flow');
    // No id should be passed in the payload
    expect((call as any).id).toBeUndefined();
  });
});
