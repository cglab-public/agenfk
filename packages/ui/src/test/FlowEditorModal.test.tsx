/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { FlowEditorModal } from '../components/FlowEditorModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { Flow, RegistryFlow } from '../types';

vi.mock('../api', () => ({
  api: {
    createFlow: vi.fn(),
    updateFlow: vi.fn(),
    setProjectFlow: vi.fn(),
    deleteFlow: vi.fn(),
    listFlows: vi.fn(),
    getProjectFlow: vi.fn(),
    getDefaultFlow: vi.fn(),
    browseRegistry: vi.fn(),
    installFromRegistry: vi.fn(),
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
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
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

  it('steps are rendered in a columns container (not a plain list)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('steps-columns'));
    expect(screen.getByTestId('steps-columns')).toBeDefined();
    // The old steps-list should no longer exist
    expect(screen.queryByTestId('steps-list')).toBeNull();
  });

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

  // ── Layout / scrollbars ────────────────────────────────────────────────────

  it('steps-columns container hides scrollbar (has overflow-x-auto and scrollbar-none or similar)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('steps-columns'));
    const container = screen.getByTestId('steps-columns');
    // Must have overflow-x-auto for scrollability but scrollbar visually hidden
    expect(container.className).toContain('overflow-x-auto');
    expect(container.className).toMatch(/scrollbar-none|scrollbar-hide|\[&::-webkit-scrollbar\]/);
  });

  it('exit criteria textarea has enough rows for comfortable editing (>= 5)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-exit-criteria-1'));
    const textarea = screen.getByTestId('step-exit-criteria-1') as HTMLTextAreaElement;
    expect(Number(textarea.rows)).toBeGreaterThanOrEqual(5);
  });

  // ── Anchor color swatch ────────────────────────────────────────────────────

  it('anchor steps show a color swatch (not a picker) with the default color', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-color-swatch-0'));
    // TODO anchor (index 0) and DONE anchor (index 2) should have swatches
    expect(screen.getByTestId('step-color-swatch-0')).toBeDefined();
    expect(screen.getByTestId('step-color-swatch-2')).toBeDefined();
    // Non-anchor (index 1) should NOT have a swatch — it has a color picker instead
    expect(screen.queryByTestId('step-color-swatch-1')).toBeNull();
  });

  it('TODO anchor swatch has gray default color', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-color-swatch-0'));
    const swatch = screen.getByTestId('step-color-swatch-0') as HTMLElement;
    // The swatch should reflect the gray TODO default color in its inline style
    expect(swatch.style.backgroundColor).toBeTruthy();
  });

  // ── Color picker ──────────────────────────────────────────────────────────

  it('color picker is rendered for non-anchor steps', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    // Middle step (index 1) should have a color picker
    await waitFor(() => screen.getByTestId('step-color-1'));
    expect(screen.getByTestId('step-color-1')).toBeDefined();
    // Anchor steps (index 0, 2) should NOT have an interactive color picker
    expect(screen.queryByTestId('step-color-0')).toBeNull();
    expect(screen.queryByTestId('step-color-2')).toBeNull();
  });

  it('color change is included in createFlow payload', async () => {
    vi.mocked(api.createFlow).mockResolvedValue({ ...SAMPLE_FLOW, id: 'new-flow' });
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('flow-name-input'));

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Colored Flow' } });
    fireEvent.change(screen.getByTestId('step-name-0'), { target: { value: 'in_progress' } });
    fireEvent.change(screen.getByTestId('step-label-0'), { target: { value: 'In Progress' } });
    fireEvent.change(screen.getByTestId('step-color-0'), { target: { value: '#ff0000' } });

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.createFlow).mock.calls[0][0];
    const middleStep = call.steps?.find((s: any) => !s.isAnchor);
    expect(middleStep?.color).toBe('#ff0000');
  });

  it('step color is seeded from loaded flow data', async () => {
    const flowWithColor: Flow = {
      ...SAMPLE_FLOW,
      steps: [
        { id: 's1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
        { id: 's2', name: 'in_review', label: 'In Review', order: 1, exitCriteria: 'Ticket refined', color: '#3b82f6' },
        { id: 's3', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
      ],
    };
    vi.mocked(api.listFlows).mockResolvedValue([flowWithColor, SAMPLE_FLOW_2]);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-color-1'));
    const colorInput = screen.getByTestId('step-color-1') as HTMLInputElement;
    expect(colorInput.value).toBe('#3b82f6');
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
    await waitFor(() => expect(api.getDefaultFlow).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => {
      // Built-in flow shows a static heading, not an editable input
      expect(screen.queryByTestId('flow-name-input')).toBeNull();
      expect(document.querySelector('h3')).toBeTruthy();
    });
    // Middle step inputs should also be disabled (anchors have no editable name input)
    const stepName = screen.getByTestId('step-name-1') as HTMLInputElement;
    expect(stepName.disabled).toBe(true);
    // Save button should NOT be visible in read-only mode
    expect(screen.queryByTestId('save-flow-btn')).toBeNull();
    // Clone to Edit button should be visible
    expect(screen.getByTestId('clone-to-edit-btn')).toBeDefined();
  });

  it('"Use this Flow" on DEFAULT calls setProjectFlow with null to revert to default', async () => {
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => expect(api.getDefaultFlow).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => screen.getByTestId('use-default-flow-btn'));
    fireEvent.click(screen.getByTestId('use-default-flow-btn'));
    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, null));
  });

  it('"Clone to Edit" on DEFAULT creates editable copy named "Copy of Default Flow"', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => expect(api.getDefaultFlow).toHaveBeenCalled());
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

  it('cloned flow uses fresh standard TODO/DONE anchors even when source has non-standard anchor data', async () => {
    // Source flow with anchors that have non-standard exitCriteria and label
    const sourceWithCustomAnchors: Flow = {
      ...SAMPLE_FLOW,
      steps: [
        { id: 's1', name: 'TODO', label: 'Start Here', order: 0, exitCriteria: 'Must triage first', isAnchor: true },
        { id: 's2', name: 'in_review', label: 'In Review', order: 1, exitCriteria: 'Ticket refined' },
        { id: 's3', name: 'DONE', label: 'Shipped!', order: 2, exitCriteria: 'All deployed', isAnchor: true },
      ],
    };
    vi.mocked(api.listFlows).mockResolvedValue([sourceWithCustomAnchors, SAMPLE_FLOW_2]);
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
    const steps = call.steps ?? [];

    const todo = steps.find((s: any) => s.name === 'TODO');
    const done = steps.find((s: any) => s.name === 'DONE');

    // Standard anchor labels and empty exitCriteria — not copied from source
    expect(todo?.label).toBe('To Do');
    expect(todo?.exitCriteria).toBe('');
    expect(done?.label).toBe('Done');
    expect(done?.exitCriteria).toBe('');

    // Middle steps are preserved
    const middle = steps.filter((s: any) => !s.isAnchor);
    expect(middle).toHaveLength(1);
    expect(middle[0].name).toBe('in_review');
  });
});

// ── Community tab ─────────────────────────────────────────────────────────────

const REGISTRY_FLOW_1: RegistryFlow = {
  filename: 'engineering-sprint.json',
  name: 'Engineering Sprint',
  author: 'acme-corp',
  version: '1.0.0',
  stepCount: 5,
  description: 'A standard engineering sprint flow',
};

const REGISTRY_FLOW_2: RegistryFlow = {
  filename: 'design-review.json',
  name: 'Design Review',
  author: 'design-team',
  version: '2.0.0',
  stepCount: 3,
  description: 'Design review process',
};

const INSTALLED_FLOW: Flow = {
  id: 'installed-flow-id',
  name: 'Engineering Sprint',
  description: 'A standard engineering sprint flow',
  steps: [
    { id: 'i1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
    { id: 'i2', name: 'in_progress', label: 'In Progress', order: 1, exitCriteria: '' },
    { id: 'i3', name: 'DONE', label: 'Done', order: 4, exitCriteria: '', isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('FlowEditorModal — Community tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_FLOW]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.browseRegistry).mockResolvedValue([REGISTRY_FLOW_1, REGISTRY_FLOW_2]);
    vi.mocked(api.installFromRegistry).mockResolvedValue(INSTALLED_FLOW);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders My Flows and Community tabs', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('tab-my-flows')).toBeDefined();
    expect(screen.getByTestId('tab-community')).toBeDefined();
  });

  it('switching to Community tab shows search input and loads registry flows', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    expect(screen.getByTestId('community-search-input')).toBeDefined();
    await waitFor(() => expect(api.browseRegistry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('community-flow-item-0')).toBeDefined());
    expect(screen.getByTestId('community-flow-item-1')).toBeDefined();
  });

  it('community search filters by name', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.change(screen.getByTestId('community-search-input'), { target: { value: 'Design' } });
    await waitFor(() => expect(screen.queryByTestId('community-flow-item-1')).toBeNull());
    expect(screen.getByTestId('community-flow-item-0')).toBeDefined();
    // Name shown should be Design Review
    expect(screen.getByTestId('community-flow-item-0').textContent).toContain('Design Review');
  });

  it('community search filters by author', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.change(screen.getByTestId('community-search-input'), { target: { value: 'acme-corp' } });
    await waitFor(() => expect(screen.queryByTestId('community-flow-item-1')).toBeNull());
    expect(screen.getByTestId('community-flow-item-0').textContent).toContain('Engineering Sprint');
  });

  it('clicking a community flow shows the preview panel', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-preview-panel'));
    expect(screen.getByTestId('community-install-btn')).toBeDefined();
    expect(screen.getByTestId('community-clone-btn')).toBeDefined();
  });

  it('Install button calls installFromRegistry and switches to My Flows tab', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-install-btn'));
    fireEvent.click(screen.getByTestId('community-install-btn'));
    await waitFor(() =>
      expect(api.installFromRegistry).toHaveBeenCalledWith('engineering-sprint.json')
    );
    // Should switch to My Flows tab after install
    await waitFor(() => expect(screen.queryByTestId('community-preview-panel')).toBeNull());
    expect(screen.getByTestId('flow-list')).toBeDefined();
  });

  it('Clone to Edit installs the flow and opens it as an editable copy', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-clone-btn'));
    fireEvent.click(screen.getByTestId('community-clone-btn'));
    await waitFor(() =>
      expect(api.installFromRegistry).toHaveBeenCalledWith('engineering-sprint.json')
    );
    // Should switch to My Flows tab with editable clone
    await waitFor(() => {
      const nameInput = screen.queryByTestId('flow-name-input') as HTMLInputElement | null;
      expect(nameInput).not.toBeNull();
      expect(nameInput!.disabled).toBe(false);
    });
  });

  it('empty state shown when no community flow is selected', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    // No flow selected yet — preview panel should not exist
    expect(screen.queryByTestId('community-preview-panel')).toBeNull();
  });

  it('switching back to My Flows shows the flow list', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-search-input'));
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    expect(screen.getByTestId('flow-list')).toBeDefined();
    expect(screen.getByTestId('new-flow-btn')).toBeDefined();
  });
});
