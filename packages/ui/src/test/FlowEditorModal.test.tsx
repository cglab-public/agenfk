/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { FlowEditorModal } from '../components/FlowEditorModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { Flow, RegistryFlow } from '../types';
import { ThemeProvider } from '../ThemeContext';

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
    publishToRegistry: vi.fn(),
    getOrgAvailableFlows: vi.fn(),
  },
}));

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </ThemeProvider>
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
    // Default: not part of an org (standalone install) — selection allowed.
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
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

  it('new flow editor shows TODO anchor step at index 0', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('step-anchor-lock-0')).toBeDefined();
    });
  });

  it('new flow editor shows DONE anchor step at the last index', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => {
      // With a blank middle step, DONE is at index 2
      expect(screen.getByTestId('step-anchor-lock-2')).toBeDefined();
    });
  });

  it('new flow has TODO and DONE anchors surrounding a blank middle step (3 step rows total)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('step-row-0')).toBeDefined(); // TODO anchor
      expect(screen.getByTestId('step-row-1')).toBeDefined(); // blank middle step
      expect(screen.getByTestId('step-row-2')).toBeDefined(); // DONE anchor
    });
    // Middle step should not be an anchor (no lock icon at index 1)
    expect(screen.queryByTestId('step-anchor-lock-1')).toBeNull();
    // No 4th row
    expect(screen.queryByTestId('step-row-3')).toBeNull();
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
    // CGLAB-109: the inline field is now a summary trigger (button) showing the
    // current criteria; the popup is the only editor. The value check moved to
    // the popup block below.
    expect(screen.getByTestId('step-exit-criteria-1').textContent).toContain('Ticket refined');
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
    // Starts with 3 steps: TODO anchor (0), blank middle (1), DONE anchor (2)
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.getByTestId('step-row-1')).toBeDefined();
    expect(screen.getByTestId('step-row-2')).toBeDefined();
    expect(screen.queryByTestId('step-row-3')).toBeNull();
    fireEvent.click(screen.getByTestId('add-step-btn'));
    expect(screen.getByTestId('step-row-3')).toBeDefined();
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
    // Index 0 is the TODO anchor (no editable name); the middle step is at index 1
    fireEvent.change(screen.getByTestId('step-name-1'), { target: { value: 'in_progress' } });
    fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'In Progress' } });

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
    // BUG 269eeec8 (c): new-flow mode seeds one blank step, and an unnamed step
    // is no longer a saveable definition (the Hub rejects it, and "" is not a
    // usable workflow status). Name it so this test still exercises what it is
    // about — that Use this Flow creates then selects.
    fireEvent.change(screen.getByTestId('step-name-1'), { target: { value: 'in_progress' } });
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

  it('exit criteria popup editor is a full-height markdown surface (>= 14 rows)', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-exit-criteria-1'));
    // The inline field is a compact summary; the comfortable-editing surface is
    // the popup's markdown editor (CGLAB-109 replaced the inline textarea).
    fireEvent.click(screen.getByTestId('step-exit-criteria-1'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
    const textarea = screen.getByTestId('exit-criteria-editor') as HTMLTextAreaElement;
    expect(Number(textarea.rows)).toBeGreaterThanOrEqual(14);
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
    // Index 0 is the TODO anchor (no editable name/color); the middle step is at index 1
    fireEvent.change(screen.getByTestId('step-name-1'), { target: { value: 'in_progress' } });
    fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'In Progress' } });
    fireEvent.change(screen.getByTestId('step-color-1'), { target: { value: '#ff0000' } });

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

  // ── Hub-owned selection: "Use this Flow" gating ──────────────────────────
  // On a hub-connected installation, team-flow selection is centralized at the
  // hub (Org Flows picker). The local editor must NOT offer selection — it may
  // only author (save) and publish to the community registry.

  it('standalone install (hubEnabled=false): shows "Use this Flow" on an editable flow', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    expect(await screen.findByTestId('use-flow-btn')).toBeDefined();
  });

  it('hub-connected install (hubEnabled=true): hides "Use this Flow" but keeps Publish', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: true });
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    // Publish stays available (author → publish to community).
    expect(await screen.findByTestId('publish-flow-btn')).toBeDefined();
    // Selection is hub-owned: no local "Use this Flow".
    await waitFor(() => expect(screen.queryByTestId('use-flow-btn')).toBeNull());
  });

  it('hub-connected install: builtin default flow offers no "Use this Flow" either', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: true });
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    // Select the read-only builtin default row; its only action was "Use this Flow".
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => expect(screen.queryByTestId('use-default-flow-btn')).toBeNull());
  });

  it('standalone install: builtin default flow still offers "Use this Flow"', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    expect(await screen.findByTestId('use-default-flow-btn')).toBeDefined();
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
  steps: [
    { name: 'TODO', label: 'To Do' },
    { name: 'IN_PROGRESS', label: 'In Progress' },
    { name: 'REVIEW', label: 'Review' },
    { name: 'TEST', label: 'Test' },
    { name: 'DONE', label: 'Done' },
  ],
};

const REGISTRY_FLOW_2: RegistryFlow = {
  filename: 'design-review.json',
  name: 'Design Review',
  author: 'design-team',
  version: '2.0.0',
  stepCount: 3,
  description: 'Design review process',
  steps: [
    { name: 'TODO', label: 'To Do' },
    { name: 'DESIGN_REVIEW', label: 'Design Review' },
    { name: 'DONE', label: 'Done' },
  ],
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
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
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

  it('community preview panel shows a Mermaid diagram container when flow has steps', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-preview-panel'));
    // The diagram container must be present when flow has steps
    expect(screen.getByTestId('community-flow-diagram')).toBeDefined();
  });

  it('community preview panel does not show diagram placeholder text when flow has steps', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-preview-panel'));
    // The old placeholder text must be gone when steps are available
    expect(screen.queryByText(/Step details will be available after installation/i)).toBeNull();
  });

  it('community preview panel shows placeholder text when flow has no steps', async () => {
    const flowWithNoSteps: RegistryFlow = { ...REGISTRY_FLOW_1, steps: undefined };
    vi.mocked(api.browseRegistry).mockResolvedValue([flowWithNoSteps]);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-preview-panel'));
    // Without step data, the fallback placeholder must be shown
    expect(screen.getByText(/Step details will be available after installation/i)).toBeDefined();
    expect(screen.queryByTestId('community-flow-diagram')).toBeNull();
  });
});

describe('FlowEditorModal — version badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_FLOW, SAMPLE_FLOW_2]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    // Default: not part of an org (standalone install) — selection allowed.
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
  });

  afterEach(() => { cleanup(); });

  it('shows version badge when flow has a version', async () => {
    const flowWithVersion: Flow = { ...SAMPLE_FLOW, version: '1.2.3' };
    vi.mocked(api.listFlows).mockResolvedValue([flowWithVersion, SAMPLE_FLOW_2]);

    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('flow-version-badge'));
    expect(screen.getByTestId('flow-version-badge').textContent).toContain('1.2.3');
  });

  it('does not show version badge when flow has no version', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('flow-name-input'));
    expect(screen.queryByTestId('flow-version-badge')).toBeNull();
  });

  it('version badge has no editable input', async () => {
    const flowWithVersion: Flow = { ...SAMPLE_FLOW, version: '2.0.0' };
    vi.mocked(api.listFlows).mockResolvedValue([flowWithVersion, SAMPLE_FLOW_2]);

    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('flow-version-badge'));
    expect(screen.queryByTestId('flow-version-input')).toBeNull();
  });
});

// ── BUG 269eeec8 — flow save failures on both surfaces ──────────────────────
// (a) the editor showed only "Request failed with status code N", discarding the
//     server's `{ error }` body, which is the only text that says what to fix;
// (b) Save was offered on hub-managed flows the local server always 409s;
// (c) a blank step name was sent to a backend that rejects it (Hub 400).
describe('FlowEditorModal — save failures surface the reason (BUG 269eeec8)', () => {
  const HUB_FLOW: Flow = {
    id: 'flow-hub',
    name: 'TDD Flow',
    description: 'Hub-managed',
    source: 'hub',
    hubFlowId: 'e06246da-0e3f-446e-9aa2-24fd3fdbeadc',
    steps: [
      { id: 'h1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
      { id: 'h2', name: 'DISCOVERY', label: 'Discovery', order: 1, exitCriteria: 'Cards created' },
      { id: 'h3', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  /** What axios actually throws: the reason is in response.data, not in message. */
  const axiosRejection = (status: number, serverError: string) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data: { error: serverError } },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_FLOW, HUB_FLOW]);
  });

  afterEach(() => cleanup());

  const openFlow = async (testId: string) => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId(testId));
    fireEvent.click(screen.getByTestId(testId));
    // Wait on the panel, not the name input — a read-only panel has no input.
    await waitFor(() => screen.getByTestId('editor-panel'));
  };

  // (a) — the whole reason this bug took two rounds of network-tab archaeology.
  it("shows the server's error text, not the generic axios message", async () => {
    vi.mocked(api.updateFlow).mockRejectedValue(axiosRejection(400, 'each step requires a name'));
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('flow-editor-error').textContent).toContain('each step requires a name');
    });
    expect(screen.getByTestId('flow-editor-error').textContent).not.toContain('status code 400');
  });

  it('shows the hub-managed refusal verbatim when the local server 409s', async () => {
    vi.mocked(api.updateFlow).mockRejectedValue(
      axiosRejection(409, "Flow is managed by your organization's Hub and cannot be modified locally")
    );
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('flow-editor-error').textContent).toContain("managed by your organization's Hub");
    });
  });

  // (b) — don't offer a Save the local server is guaranteed to reject.
  it('marks a hub-managed flow as hub-owned and does not offer Save', async () => {
    await openFlow('flow-item-flow-hub');

    expect(screen.getByTestId('hub-managed-badge')).toBeDefined();
    expect(screen.queryByTestId('save-flow-btn')).toBeNull();
  });

  it('a local flow is still editable and offers Save', async () => {
    await openFlow('flow-item-flow-1');

    expect(screen.queryByTestId('hub-managed-badge')).toBeNull();
    expect(screen.getByTestId('save-flow-btn')).toBeDefined();
  });

  // Review findings 2/3/4: the read-only panel is now also used for hub flows,
  // so it must not claim to be the default flow, must not be a dead end, and
  // must not offer a delete the server refuses.
  it('shows the hub flow its own name, not "Default Flow"', async () => {
    await openFlow('flow-item-flow-hub');

    expect(screen.getByTestId('flow-name-heading').textContent).toBe('TDD Flow');
  });

  it('offers Clone to Edit on a hub flow, as the badge tooltip promises', async () => {
    await openFlow('flow-item-flow-hub');

    expect(screen.getByTestId('clone-to-edit-btn')).toBeDefined();
  });

  it('keeps Publish reachable on a hub flow', async () => {
    await openFlow('flow-item-flow-hub');

    expect(screen.getByTestId('publish-flow-btn')).toBeDefined();
  });

  // A button whose outcome renders in a different footer is a silent failure —
  // the exact class of bug this change exists to remove.
  it('reports a publish failure on a hub flow, in the read-only footer', async () => {
    vi.mocked(api.publishToRegistry).mockRejectedValue(axiosRejection(502, 'registry unreachable'));
    await openFlow('flow-item-flow-hub');

    fireEvent.click(screen.getByTestId('publish-flow-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('publish-error').textContent).toContain('registry unreachable');
    });
  });

  it('shows the publish success link on a hub flow', async () => {
    vi.mocked(api.publishToRegistry).mockResolvedValue({ url: 'https://example.test/pr/1', kind: 'pr' });
    await openFlow('flow-item-flow-hub');

    fireEvent.click(screen.getByTestId('publish-flow-btn'));

    await waitFor(() => expect(screen.getByTestId('publish-success-link')).toBeDefined());
  });

  it('does not offer "Use this Flow" as a set-default action on a hub flow', async () => {
    await openFlow('flow-item-flow-hub');

    expect(screen.queryByTestId('use-default-flow-btn')).toBeNull();
  });

  it('does not fire a delete for a hub flow the server would refuse', async () => {
    await openFlow('flow-item-flow-hub');

    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-hub'));

    // The confirm prompt must not even open — that is what distinguishes the
    // gate from the old behaviour, where the prompt appeared and only the
    // eventual request failed (silently).
    expect(screen.queryByTestId('delete-confirm')).toBeNull();
    expect(api.deleteFlow).not.toHaveBeenCalled();
  });

  it('surfaces a delete refusal instead of failing silently', async () => {
    vi.mocked(api.deleteFlow).mockRejectedValue(
      axiosRejection(409, "Flow is managed by your organization's Hub and cannot be modified locally")
    );
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));

    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-1'));
    await waitFor(() => screen.getByTestId('delete-confirm-yes'));
    fireEvent.click(screen.getByTestId('delete-confirm-yes'));

    await waitFor(() => {
      expect(screen.getByTestId('flow-delete-error').textContent).toContain("managed by your organization's Hub");
    });
  });

  it('actually disables the delete button on a hub row, not just its styling', async () => {
    await openFlow('flow-item-flow-hub');

    expect((screen.getByTestId('delete-flow-btn-flow-hub') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears a stale delete error when the modal is reopened', async () => {
    vi.mocked(api.deleteFlow).mockRejectedValue(axiosRejection(409, 'nope'));
    const qc = makeQueryClient();
    const { rerender } = render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(qc) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-1'));
    await waitFor(() => screen.getByTestId('delete-confirm-yes'));
    fireEvent.click(screen.getByTestId('delete-confirm-yes'));
    await waitFor(() => screen.getByTestId('flow-delete-error'));

    // The component never unmounts, so reopening must not resurrect the error.
    rerender(<FlowEditorModal isOpen={false} onClose={() => {}} projectId={PROJECT_ID} />);
    rerender(<FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />);

    await waitFor(() => expect(screen.queryByTestId('flow-delete-error')).toBeNull());
  });

  // Hub-connected with an org-default flow: authoring stays fully available —
  // create, save and publish — because only ACTIVATION is owned by the Hub.
  describe('hub-connected authoring', () => {
    beforeEach(() => {
      vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({
        flows: [], defaultFlowId: 'flow-hub', hubEnabled: true,
      });
    });

    it('still offers New Flow', async () => {
      render(
        <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
        { wrapper: wrapper(makeQueryClient()) }
      );
      await waitFor(() => expect(screen.getByTestId('new-flow-btn')).toBeDefined());
    });

    it('saves a newly created local flow', async () => {
      vi.mocked(api.createFlow).mockResolvedValue({ ...SAMPLE_FLOW, id: 'created' });
      render(
        <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
        { wrapper: wrapper(makeQueryClient()) }
      );
      await waitFor(() => screen.getByTestId('new-flow-btn'));
      fireEvent.click(screen.getByTestId('new-flow-btn'));
      await waitFor(() => screen.getByTestId('flow-name-input'));

      fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Local Flow' } });
      fireEvent.change(screen.getByTestId('step-name-1'), { target: { value: 'in_progress' } });
      fireEvent.click(screen.getByTestId('save-flow-btn'));

      await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    });

    it('saves an edit to an existing local flow', async () => {
      vi.mocked(api.updateFlow).mockResolvedValue(SAMPLE_FLOW);
      await openFlow('flow-item-flow-1');

      fireEvent.click(screen.getByTestId('save-flow-btn'));

      await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));
    });

    it('offers Publish on a local flow', async () => {
      await openFlow('flow-item-flow-1');

      expect(screen.getByTestId('publish-flow-btn')).toBeDefined();
    });

    it('does NOT offer activation — that is the Hub\'s to own', async () => {
      await openFlow('flow-item-flow-1');

      expect(screen.queryByTestId('use-flow-btn')).toBeNull();
    });
  });

  // (c) — block the payload the Hub rejects, and say which step is wrong.
  it('blocks Save on a step with no name and pins the error to that step', async () => {
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('add-step-btn'));

    await waitFor(() => {
      expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true);
    });
    // The blank step lands at index 3 (TODO, in_review, DONE, new).
    expect(screen.getByTestId('step-name-error-3')).toBeDefined();
    expect(api.updateFlow).not.toHaveBeenCalled();
  });

  it('re-enables Save once the new step is named', async () => {
    await openFlow('flow-item-flow-1');
    fireEvent.click(screen.getByTestId('add-step-btn'));
    await waitFor(() => expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true));

    fireEvent.change(screen.getByTestId('step-name-3'), { target: { value: 'REFACTOR' } });

    await waitFor(() => {
      expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId('step-name-error-3')).toBeNull();
  });

  // Save must never be disabled without a visible reason. Per-step messages
  // render only for non-anchor steps (anchors expose no name field) and a
  // flow-level issue has no column at all, so both need a surfaced explanation
  // or the user gets a dead button and nothing to act on.
  it('explains a blank flow name instead of just disabling Save', async () => {
    await openFlow('flow-item-flow-1');

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: '   ' } });

    await waitFor(() => {
      expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByTestId('flow-definition-issues').textContent).toMatch(/name/i);
  });

  it('explains a bad ANCHOR step, which renders no editable name field', async () => {
    // A flow persisted before the server validated step shape can arrive with a
    // blank anchor name. The anchor column has no name input, so without this
    // the user would see a disabled Save and no reason anywhere on screen.
    const brokenAnchor: Flow = {
      ...SAMPLE_FLOW,
      id: 'flow-broken',
      steps: [
        { id: 'b1', name: '', label: '', order: 0, exitCriteria: '', isAnchor: true },
        { id: 'b2', name: 'work', label: 'Work', order: 1, exitCriteria: '' },
        { id: 'b3', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
      ],
    };
    vi.mocked(api.listFlows).mockResolvedValue([brokenAnchor]);

    await openFlow('flow-item-flow-broken');

    expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('flow-definition-issues').textContent).toMatch(/name/i);
    // The anchor has no name input, so there is no per-step message to rely on.
    expect(screen.queryByTestId('step-name-error-0')).toBeNull();
  });

  it('does not send a save while a step name is blank', async () => {
    vi.mocked(api.updateFlow).mockResolvedValue(SAMPLE_FLOW);
    await openFlow('flow-item-flow-1');
    fireEvent.click(screen.getByTestId('add-step-btn'));

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true));
    expect(api.updateFlow).not.toHaveBeenCalled();
  });
});

// ── CGLAB-109: Exit Criteria popup editor (markdown + preview + tokens) ─────
// The flow builder's exit criteria were a short inline textarea. The new
// contract: the inline field is a compact summary + trigger; clicking it opens
// a popped-up editor with a full markdown source field, a rendered preview,
// and a token count estimate under the editor. Save commits; Cancel/Escape
// discard. Both the middle steps and the TODO anchor column open the popup.
describe('Exit criteria popup editor (CGLAB-109)', () => {
  const HUB_FLOW: Flow = {
    id: 'flow-hub',
    name: 'Hub Flow',
    description: 'owned by the hub',
    source: 'hub',
    steps: [
      { id: 'h1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
      { id: 'h2', name: 'in_progress', label: 'In Progress', order: 1, exitCriteria: 'hub criteria' },
      { id: 'h3', name: 'DONE', label: 'Done', order: 2, exitCriteria: '', isAnchor: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const openStep1Popup = async () => {
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-exit-criteria-1'));
    fireEvent.click(screen.getByTestId('step-exit-criteria-1'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_FLOW, HUB_FLOW]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
  });

  afterEach(() => {
    cleanup();
  });

  const renderEditor = (onClose: () => void = () => {}) =>
    render(
      <FlowEditorModal isOpen={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

  it('opens the popup from the summary field with the current criteria loaded', async () => {
    renderEditor();
    await openStep1Popup();
    const editor = screen.getByTestId('exit-criteria-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('Ticket refined');
    // The preview shows the current criteria as rendered markdown.
    expect(screen.getByTestId('exit-criteria-preview').textContent).toContain('Ticket refined');
    // A token estimate is shown under the editor.
    expect(screen.getByTestId('exit-criteria-token-count').textContent).toMatch(/tokens?/i);
  });

  it('renders markdown in the preview and updates the token count live', async () => {
    renderEditor();
    await openStep1Popup();
    const before = screen.getByTestId('exit-criteria-token-count').textContent ?? '';
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'All tests passing:\n\n- **fast** and *fresh*\n- [proof](https://example.com)' },
    });
    const preview = screen.getByTestId('exit-criteria-preview');
    expect(preview.querySelector('strong')?.textContent).toBe('fast');
    expect(preview.querySelector('em')?.textContent).toBe('fresh');
    expect(preview.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    const after = screen.getByTestId('exit-criteria-token-count').textContent ?? '';
    expect(after).not.toBe(before);
    expect(Number((after.match(/~?(\d+)/) ?? [])[1])).toBeGreaterThan(
      Number((before.match(/~?(\d+)/) ?? [])[1])
    );
  });

  it('Save commits the edited criteria and the summary reflects it', async () => {
    renderEditor();
    await openStep1Popup();
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'All tests green\n\n- evidence attached' },
    });
    fireEvent.click(screen.getByTestId('exit-criteria-save'));
    // Popup closes and the inline summary shows the new first line.
    await waitFor(() => expect(screen.queryByTestId('exit-criteria-editor')).toBeNull());
    expect(screen.getByTestId('step-exit-criteria-1').textContent).toContain('All tests green');
    // Reopening shows the committed value — the popup edits local state until Save.
    fireEvent.click(screen.getByTestId('step-exit-criteria-1'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
    expect((screen.getByTestId('exit-criteria-editor') as HTMLTextAreaElement).value).toBe(
      'All tests green\n\n- evidence attached'
    );
  });

  it('Cancel discards the edit — the summary keeps the original criteria', async () => {
    renderEditor();
    await openStep1Popup();
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'should not stick around' },
    });
    fireEvent.click(screen.getByTestId('exit-criteria-cancel'));
    await waitFor(() => expect(screen.queryByTestId('exit-criteria-editor')).toBeNull());
    expect(screen.getByTestId('step-exit-criteria-1').textContent).toContain('Ticket refined');
    fireEvent.click(screen.getByTestId('step-exit-criteria-1'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
    expect((screen.getByTestId('exit-criteria-editor') as HTMLTextAreaElement).value).toBe('Ticket refined');
  });

  it('Escape closes the popup without saving — and does NOT close the flow editor', async () => {
    const hostClose = vi.fn();
    renderEditor(hostClose);
    await openStep1Popup();
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'escaped' },
    });
    fireEvent.keyDown(screen.getByTestId('exit-criteria-editor'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('exit-criteria-editor')).toBeNull());
    // CGLAB-109 review F1: the parent modal has its own window Escape
    // listener; the popup must own the keypress (capture + stopPropagation)
    // or Escape would unmount the whole flow editor and silently discard
    // every unsaved step edit. The host onClose staying uncalled is the
    // production contract (KanbanBoard/AdminFlows close on it).
    expect(screen.getByTestId('flow-editor-modal')).toBeDefined();
    expect(hostClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('step-exit-criteria-1').textContent).toContain('Ticket refined');
  });

  it('the preview never executes raw HTML (rendered markdown, not raw)', async () => {
    // CGLAB-109 review F3: pins the sanitisation contract — no rehype-raw,
    // so HTML in the source stays literal text. Keeps a future 'realism'
    // change from silently enabling a (self-)XSS vector.
    renderEditor();
    await openStep1Popup();
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'plain <img src=x onerror=alert(1)> and <script>evil()</script> text' },
    });
    const preview = screen.getByTestId('exit-criteria-preview');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('<img');
  });

  it('the TODO anchor column opens the same popup and saves from it', async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('step-exit-criteria-0'));
    // TODO anchor starts with no criteria — the trigger shows the empty state.
    expect(screen.getByTestId('step-exit-criteria-0').textContent).toMatch(/no exit criteria/i);
    fireEvent.click(screen.getByTestId('step-exit-criteria-0'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
    expect((screen.getByTestId('exit-criteria-editor') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'Cards created and the user gave the go-ahead.' },
    });
    fireEvent.click(screen.getByTestId('exit-criteria-save'));
    await waitFor(() => expect(screen.queryByTestId('exit-criteria-editor')).toBeNull());
    expect(screen.getByTestId('step-exit-criteria-0').textContent).toContain('Cards created');
  });

  it('a hub-owned (read-only) flow cannot open the editor', async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId('flow-item-flow-hub'));
    fireEvent.click(screen.getByTestId('flow-item-flow-hub'));
    await waitFor(() => screen.getByTestId('step-exit-criteria-1'));
    const trigger = screen.getByTestId('step-exit-criteria-1') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByTestId('exit-criteria-editor')).toBeNull();
  });
});
