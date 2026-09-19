/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { FlowEditorModal } from '../components/FlowEditorModal';
import { FlowEditorModal as SharedFlowEditorModal, type RegistryClient } from '@agenfk/flow-editor';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { Flow, RegistryFlow } from '../types';
import { ThemeProvider } from '../ThemeContext';
import mermaid from 'mermaid';
import { rawPaletteClasses, deadHoverClasses } from './rawPaletteClasses';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg />' })),
  },
}));

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
    { id: 'd2', name: 'IN_PROGRESS', label: 'In Progress', order: 1, exitCriteria: '' },
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
    { id: 's5', name: 'IN_PROGRESS', label: 'In Progress', order: 1, exitCriteria: '' },
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
    expect(screen.getByTestId('step-name-1').textContent).toBe('in_review');
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
    fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'In Progress' } });
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

  it('derives a NEW step\u2019s key from the label typed into it', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('add-step-btn'));
    fireEvent.click(screen.getByTestId('add-step-btn'));
    // A blank step has no key of its own, so the label writes it.
    const blankField = await waitFor(() => {
      const empty = (screen.getAllByTestId(/^step-label-\d+$/) as HTMLInputElement[]).find(i => i.value === '');
      if (!empty) throw new Error('no blank step was added');
      return empty;
    });
    const at = blankField.getAttribute('data-testid')!.replace('step-label-', '');
    fireEvent.change(blankField, { target: { value: 'QA review' } });
    expect(screen.getByTestId(`step-name-${at}`).textContent).toBe('QA_REVIEW');
    expect(screen.queryByTestId(`step-reserved-error-${at}`)).toBeNull();
  });

  // The other half, and the one that protects a live flow: a key somebody set
  // by hand is a decision. `in_review` is not what "In Review" derives to, so
  // renaming the label must not move every item off that status.
  it('leaves a hand-set key alone when the label changes', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    // index 1 is the middle (non-anchor) step
    await waitFor(() => screen.getByTestId('step-name-1'));
    const nameKey = screen.getByTestId('step-name-1');
    fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'QA review' } });
    expect(nameKey.textContent).toBe('in_review');
    expect(screen.queryByTestId('step-reserved-error-1')).toBeNull();
  });

  it('shows Reserved name error and disables Save when a reserved name is typed', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('add-step-btn'));
    // A blank step, because a key already set by hand does not follow its
    // label — which is the whole point of nextStepName.
    fireEvent.click(screen.getByTestId('add-step-btn'));
    const blankField = await waitFor(() => {
      const empty = (screen.getAllByTestId(/^step-label-\d+$/) as HTMLInputElement[]).find(i => i.value === '');
      if (!empty) throw new Error('no blank step was added');
      return empty;
    });
    const blank = blankField.getAttribute('data-testid')!.replace('step-label-', '');
    fireEvent.change(blankField, { target: { value: 'Blocked' } });
    await waitFor(() => screen.getByTestId(`step-reserved-error-${blank}`));
    expect(screen.getByTestId(`step-reserved-error-${blank}`).textContent).toBe('Reserved name');
    // Save button should be disabled
    const saveBtn = screen.getByTestId('save-flow-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  // ── Layout / scrollbars ────────────────────────────────────────────────────

  // Superseded by the vertical list (CGLAB-164). The container used to be a
  // horizontal kanban strip — `overflow-x-auto` with the scrollbar hidden —
  // which put 664px of steps past the right edge and made drag-to-reorder a
  // drag across a scroll. The assertion is inverted deliberately: it now pins
  // that there is NO horizontal scroller, so a revert to columns fails here.
  it('steps container is a vertical list, not a horizontal scroller', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('steps-columns'));
    const container = screen.getByTestId('steps-columns');
    expect(container.className).toContain('flex-col');
    expect(container.className).not.toContain('overflow-x-auto');
    expect(container.className).not.toContain('flex-row');
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
    await waitFor(() => screen.getByTestId('add-step-btn'));
    // A blank step, because a key already set by hand does not follow its
    // label — which is the whole point of nextStepName.
    fireEvent.click(screen.getByTestId('add-step-btn'));
    const blankField = await waitFor(() => {
      const empty = (screen.getAllByTestId(/^step-label-\d+$/) as HTMLInputElement[]).find(i => i.value === '');
      if (!empty) throw new Error('no blank step was added');
      return empty;
    });
    const blank = blankField.getAttribute('data-testid')!.replace('step-label-', '');
    fireEvent.change(blankField, { target: { value: 'blocked' } });
    await waitFor(() => screen.getByTestId(`step-reserved-error-${blank}`));
    expect(screen.getByTestId(`step-reserved-error-${blank}`)).toBeDefined();
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
    // The middle step's one editable field is disabled. The KEY is no longer
    // a field to disable — it is derived text, in both panels — so the claim
    // moves to the label, which is what read-only has to stop you changing.
    expect((screen.getByTestId('step-label-1') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('step-name-1').tagName).toBe('P');
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
    { id: 'i2', name: 'IN_PROGRESS', label: 'In Progress', order: 1, exitCriteria: '' },
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

  /*
   * CGLAB-187. A community flow is authored by someone else and reaches the
   * diagram renderer, whose SVG is injected with innerHTML. Mermaid's `loose`
   * level skips its own URL sanitization, so untrusted flow steps could carry
   * a `javascript:` link into the DOM. Pinned at the call site.
   */
  it('renders the community flow diagram at a URL-sanitizing security level, never "loose"', async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-preview-panel'));

    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());
    const calls = vi.mocked(mermaid.initialize).mock.calls;
    const config = calls[calls.length - 1][0] as { securityLevel?: string };
    expect(config.securityLevel).not.toBe('loose');
    expect(config.securityLevel).toBe('strict');
  });

  /*
   * F1 from the CGLAB-187 adversarial review. A community flow's step label is
   * untrusted and was interpolated into the Mermaid source unescaped: a `"`
   * terminated the quoted label (blank preview) and a newline injected extra
   * statements. At 'strict' neither becomes script, but the diagram source is
   * data and must not be breakable by its input.
   */
  it('escapes untrusted community step labels before building the diagram source', async () => {
    const EVIL: RegistryFlow = {
      filename: 'evil.json',
      name: 'Evil Flow',
      author: 'attacker',
      version: '1.0.0',
      stepCount: 2,
      steps: [
        { name: 'A', label: 'x"]\n  click 1 "javascript:alert(1)"\n  ["y' },
        { name: 'B', label: 'B' },
      ],
    };
    vi.mocked(api.browseRegistry).mockResolvedValue([EVIL]);
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-community'));
    await waitFor(() => screen.getByTestId('community-flow-item-0'));
    fireEvent.click(screen.getByTestId('community-flow-item-0'));
    await waitFor(() => screen.getByTestId('community-preview-panel'));
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());

    const renderCalls = vi.mocked(mermaid.render).mock.calls;
    const chart = String(renderCalls[renderCalls.length - 1][1]);
    // The label cannot start a new statement line, and its quotes are entities.
    expect(chart).not.toMatch(/^\s*click\b/m);
    expect(chart).toContain('&quot;');
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
      fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'In Progress' } });
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

    fireEvent.change(screen.getByTestId('step-label-3'), { target: { value: 'Refactor' } });

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

// ── Footer CTAs: capability-gated, not read-only-gated ──────────────────────
//
// The footer used to branch on `isReadOnly`, which produced three separate
// confusions the admin reported as "Save / Publish / Use this flow — rather
// confusing":
//   1. A host with no registry publish path still rendered a Publish button
//      wired to a client method that can only throw.
//   2. "Use this Flow" bound the flow id it already had, so unsaved edits were
//      silently dropped while the button looked like the primary action.
//   3. A freshly created flow rendered the read-only footer, which offered
//      neither Save (editable footer) nor Publish (gated on `flow?.id`).
// The footer is now capability-driven: each CTA renders iff its host can do it.
describe('flow editor footer CTAs', () => {
  const NEW_FLOW = { ...SAMPLE_FLOW, id: 'created-flow' };

  const HUB_FLOW_LOCAL: Flow = {
    ...SAMPLE_FLOW,
    id: 'flow-hub',
    name: 'TDD Flow',
    source: 'hub',
    hubFlowId: 'hub-tdd',
  };

  // This block sits at module scope (it is not nested in the big
  // `FlowEditorModal` describe), so it owns its fixtures — same shapes the
  // sibling blocks use.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_FLOW, SAMPLE_FLOW_2]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
  });

  afterEach(() => cleanup());

  const renderEditor = () =>
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

  const openFlow = async (testId: string) => {
    renderEditor();
    await waitFor(() => screen.getByTestId(testId));
    fireEvent.click(screen.getByTestId(testId));
    await waitFor(() => screen.getByTestId('editor-panel'));
  };

  /** Drive the panel into the "new flow" state with a valid, saveable name. */
  const startNewFlow = async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId('new-flow-btn'));
    fireEvent.click(screen.getByTestId('new-flow-btn'));
    await waitFor(() => screen.getByTestId('flow-name-input'));
    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Brand New' } });
    fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'In Progress' } });
  };

/**
 * Wait for a write to LAND, not merely to depart (BUG c3ff590a).
 *
 * `waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1))` resolves the
 * moment the call goes out, while the mutation is still pending. The footer's
 * buttons are disabled for exactly that window — `isSaveDisabled` includes
 * `isBusy` — and `fireEvent.click` on a disabled button does nothing at all, in
 * silence. A test that clicks the next button there sees "0 calls" and looks
 * like a product bug.
 *
 * Without load the mocked promise settles in the same tick and the window is
 * invisible; under load it opens and the click falls into it. That is the whole
 * of this file's flakiness: the failure rate went from 0-in-6 running the file
 * alone to 2-in-3 running the whole ui suite.
 *
 * The label going back to "Save"/"Saved" is the visible half of the same fact,
 * which is the signal the bind test at the bottom of this file was already
 * using.
 */
const saveSettled = async () => {
  await waitFor(() => {
    const btn = screen.getByTestId('save-flow-btn') as HTMLButtonElement;
    expect(btn.disabled, 'the save is still in flight').toBe(false);
  });
};

  /** The JSON the editor would send for the current panel state. */
  const lastWrite = () => {
    const updateCall = vi.mocked(api.updateFlow).mock.calls[0];
    const createCall = vi.mocked(api.createFlow).mock.calls[0];
    return (updateCall?.[1] ?? createCall?.[0]) as Partial<Flow>;
  };

  /**
   * Render the SHARED editor with an explicit host, so a test can hand it a
   * client that lacks a capability. The `../components/FlowEditorModal` wrapper
   * builds its clients from the mocked api object, and a mocked method set to
   * `undefined` still counts as present — which is exactly the distinction
   * capability-gating turns on, so it has to be tested at the real boundary.
   */
  const renderHosted = (
    overrides: Partial<React.ComponentProps<typeof SharedFlowEditorModal>> = {},
  ) =>
    render(
      <SharedFlowEditorModal
        isOpen={true}
        onClose={() => {}}
        projectId={PROJECT_ID}
        flowClient={{
          listFlows: () => api.listFlows(),
          getDefaultFlow: () => api.getDefaultFlow(),
          createFlow: (p) => api.createFlow(p),
          updateFlow: (id, p) => api.updateFlow(id, p),
          deleteFlow: (id) => api.deleteFlow(id),
          setProjectFlow: (projectId, flowId) => api.setProjectFlow(projectId, flowId),
        }}
        registryClient={{
          browseRegistry: () => api.browseRegistry(),
          installFromRegistry: (f) => api.installFromRegistry(f),
          publishToRegistry: (id) => api.publishToRegistry(id),
        }}
        theme="light"
        {...overrides}
      />,
      { wrapper: wrapper(makeQueryClient()) }
    );

  /** A RegistryClient with `publishToRegistry` genuinely absent, not stubbed. */
  const registryClientWithoutPublish = (): RegistryClient => ({
    browseRegistry: () => api.browseRegistry(),
    installFromRegistry: (f: string) => api.installFromRegistry(f),
  });

  // ── 1. Publish is capability-gated ────────────────────────────────────────

  it('hides Publish when the host has no registry publish path', async () => {
    // The hub admin's RegistryClient has no publish: the org's PAT lives on the
    // hub and the hub has no publish route, so its client omits the method
    // rather than carrying one that can only throw. A button that can only
    // error is not an action.
    renderHosted({ registryClient: registryClientWithoutPublish() });
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('editor-panel'));

    expect(screen.queryByTestId('publish-flow-btn')).toBeNull();
    // Save is unaffected — losing publish must not cost the admin their editor.
    expect(screen.getByTestId('save-flow-btn')).toBeDefined();
  });

  it('offers Publish when the host can publish', async () => {
    await openFlow('flow-item-flow-1');

    expect(screen.getByTestId('publish-flow-btn')).toBeDefined();
  });

  // ── 3. "Use this Flow" cannot bind an unsaved edit ────────────────────────

  it('saves the pending edit before binding, so the assignment is not stale', async () => {
    const callOrder: string[] = [];
    vi.mocked(api.updateFlow).mockImplementation(async () => {
      callOrder.push('updateFlow');
      return SAMPLE_FLOW;
    });
    vi.mocked(api.setProjectFlow).mockImplementation(async () => {
      callOrder.push('setProjectFlow');
    });
    await openFlow('flow-item-flow-1');

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));
    // The rename is what gets persisted — before the bind, not instead of it.
    expect(lastWrite().name).toBe('Renamed');
    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'flow-1'));
    // The bind must not have fired before the save resolved — that is the race
    // this test exists for, and it is what made the button bind the old version.
    expect(callOrder).toEqual(['updateFlow', 'setProjectFlow']);
  });

  it('binds without a redundant write when nothing changed', async () => {
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'flow-1'));
    expect(api.updateFlow).not.toHaveBeenCalled();
    expect(api.createFlow).not.toHaveBeenCalled();
  });

  it('refuses to bind a dirty flow whose save failed, rather than binding the old version', async () => {
    vi.mocked(api.updateFlow).mockRejectedValue(
      Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: 'flow is managed by the Hub' } },
      })
    );
    await openFlow('flow-item-flow-1');

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() => expect(screen.getByTestId('flow-editor-error')).toBeDefined());
    expect(api.setProjectFlow).not.toHaveBeenCalled();
  });

  // ── 4. A newly created flow is never a dead end ───────────────────────────

  it('offers both Save and Publish on a newly created flow', async () => {
    // The read-only footer gated Publish on `flow?.id`, which is undefined for
    // an unsaved flow — so the new-flow panel showed neither Save (other
    // footer) nor Publish (this gate).
    await startNewFlow();

    expect(screen.getByTestId('save-flow-btn')).toBeDefined();
    expect(screen.getByTestId('publish-flow-btn')).toBeDefined();
  });

  it('publishes the flow created by Save, not a stale id', async () => {
    vi.mocked(api.createFlow).mockResolvedValue(NEW_FLOW);
    vi.mocked(api.publishToRegistry).mockResolvedValue({ url: 'https://example.test/pr/9', kind: 'pr' });
    await startNewFlow();

    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    // The write has to LAND before the next button is clickable — see
    // saveSettled. Waiting for the call alone is what made this file flaky.
    await saveSettled();

    fireEvent.click(screen.getByTestId('publish-flow-btn'));
    await waitFor(() => expect(api.publishToRegistry).toHaveBeenCalledWith('created-flow'));
    expect(screen.getByTestId('publish-success-link')).toBeDefined();
  });

  // ── Save clears the dirty state ───────────────────────────────────────────
  //
  // The dirty flag is what decides whether bind/publish must write first. A
  // save that leaves it set would fire a redundant write on every following
  // action — and `rebaseOn` is the only thing that clears it, so a mutant that
  // drops the re-baseline is invisible to every other test here.

  it('a successful Save clears the dirty state, so the next bind does not re-write', async () => {
    // Both servers answer a write with the stored row, so the fake echoes the
    // name back — that response is what the dirty baseline is rebuilt from.
    vi.mocked(api.updateFlow).mockResolvedValue({ ...SAMPLE_FLOW, name: 'Renamed' });
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    await openFlow('flow-item-flow-1');

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));
    // The badge is the visible half of the same fact.
    expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).textContent).toContain('Saved');

    // Clean now. Binding must not pay for a second write.
    fireEvent.click(screen.getByTestId('use-flow-btn'));
    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'flow-1'));
    expect(api.updateFlow).toHaveBeenCalledTimes(1);
  });

  it('the baseline comes from the server response, not the request', async () => {
    // Both servers run steps through normalizeFlowSteps (field whitelist, ids
    // re-issued for duplicates/missing ones). A baseline built from what the
    // panel SENT would leave a legitimate write permanently dirty.
    const serverNormalized: Flow = {
      ...SAMPLE_FLOW,
      name: 'Renamed',
      steps: SAMPLE_FLOW.steps.map(s => ({ ...s, exitCriteria: s.exitCriteria ?? '' })),
    };
    vi.mocked(api.updateFlow).mockResolvedValue(serverNormalized);
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    await openFlow('flow-item-flow-1');

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));

    // The write has to LAND before the next button is clickable — see
    // saveSettled. Waiting for the call alone is what made this file flaky.
    await saveSettled();

    fireEvent.click(screen.getByTestId('use-flow-btn'));
    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalled());
    expect(api.updateFlow).toHaveBeenCalledTimes(1);
  });

  it('publishes the edits made since the last save, not the stored version', async () => {
    // Publish pushes the SERVER's copy. Without save-first, an edit typed after
    // the last save would silently not be in what gets published.
    vi.mocked(api.updateFlow).mockResolvedValue({ ...SAMPLE_FLOW, name: 'Renamed' });
    vi.mocked(api.publishToRegistry).mockResolvedValue({ url: 'https://example.test/pr/9', kind: 'pr' });
    await openFlow('flow-item-flow-1');

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('publish-flow-btn'));

    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));
    expect(lastWrite().name).toBe('Renamed');
    await waitFor(() => expect(api.publishToRegistry).toHaveBeenCalledWith('flow-1'));
  });

  // ── Publish is blocked for exactly the reasons Save is ────────────────────

  it('disables Publish when the definition is unsaveable, with the reason as tooltip', async () => {
    // Publish pushes the server's copy, and the way to fix a broken definition
    // is to save a fixed one. Offering Publish on a flow that cannot be saved
    // means a click that can only push the stale version.
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('add-step-btn'));

    const publish = screen.getByTestId('publish-flow-btn') as HTMLButtonElement;
    await waitFor(() => expect(publish.disabled).toBe(true));
    // A dead button must say why — the same rule Save already follows.
    expect(publish.title).toBeTruthy();
    expect(api.publishToRegistry).not.toHaveBeenCalled();
  });

  it('re-enables Publish once the definition is valid again', async () => {
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('add-step-btn'));
    await waitFor(() =>
      expect((screen.getByTestId('publish-flow-btn') as HTMLButtonElement).disabled).toBe(true));

    fireEvent.change(screen.getByTestId('step-label-3'), { target: { value: 'Refactor' } });

    await waitFor(() =>
      expect((screen.getByTestId('publish-flow-btn') as HTMLButtonElement).disabled).toBe(false));
  });

  // ── The "Saved" badge uses the HOST's caption ─────────────────────────────

  it('uses the host\'s confirmation caption, not the editor default', async () => {
    // The hub host renames Save; the confirmation has to follow it, or the
    // button flips from "Save & publish to org" to the standalone "Saved" and
    // the admin loses the fact that saving was the publish. Also why `saved`
    // is its own caption rather than a suffix rule: appending "d" to the hub's
    // caption would read "Save & publish to orgd".
    vi.mocked(api.updateFlow).mockResolvedValue(SAMPLE_FLOW);
    renderHosted({
      labels: {
        save: 'Save & publish to org',
        saved: 'Published to org',
        useFlow: 'Set as org default',
      },
    });
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('save-flow-btn'));

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('save-flow-btn').textContent).toBe('Published to org'));
  });

  it('renders ONE footer for a new flow, with both buttons in it', async () => {
    // The two footers used to be picked by read-only-ness, which split Save and
    // Publish across them. One footer now, so a button's outcome can never
    // render somewhere the user isn't looking.
    await startNewFlow();

    const panel = screen.getByTestId('editor-panel');
    const footers = Array.from(panel.querySelectorAll('[data-testid="flow-footer"]'));
    expect(footers).toHaveLength(1);
    expect(footers[0].querySelector('[data-testid="save-flow-btn"]')).not.toBeNull();
    expect(footers[0].querySelector('[data-testid="publish-flow-btn"]')).not.toBeNull();
  });

  it('renders the publish outcome inside the same footer as the button', async () => {
    vi.mocked(api.publishToRegistry).mockResolvedValue({ url: 'https://example.test/pr/9', kind: 'pr' });
    await openFlow('flow-item-flow-1');

    fireEvent.click(screen.getByTestId('publish-flow-btn'));
    await waitFor(() => expect(screen.getByTestId('publish-success-link')).toBeDefined());

    const footer = screen.getByTestId('flow-footer');
    expect(footer.contains(screen.getByTestId('publish-flow-btn'))).toBe(true);
    expect(footer.contains(screen.getByTestId('publish-success-link'))).toBe(true);
  });

  it('the read-only builtin flow offers no Save and no activation, only Clone', async () => {
    // The builtin default has no row to write and is not a publishable
    // definition; its actions are Clone to Edit and reverting to default.
    renderEditor();
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => screen.getByTestId('editor-panel'));

    expect(screen.queryByTestId('save-flow-btn')).toBeNull();
    expect(screen.queryByTestId('use-flow-btn')).toBeNull();
    expect(screen.getByTestId('clone-to-edit-btn')).toBeDefined();
    expect(screen.getByTestId('use-default-flow-btn')).toBeDefined();
  });

  it('a hub-owned flow on a hub-connected client offers no Save', async () => {
    // The local server 409s any write to a source='hub' flow, so Save must not
    // be offered here (BUG 269eeec8 (b)).
    vi.mocked(api.listFlows).mockResolvedValue([HUB_FLOW_LOCAL]);
    renderEditor();
    await waitFor(() => screen.getByTestId('flow-item-flow-hub'));
    fireEvent.click(screen.getByTestId('flow-item-flow-hub'));
    await waitFor(() => screen.getByTestId('editor-panel'));

    expect(screen.getByTestId('hub-managed-badge')).toBeDefined();
    expect(screen.queryByTestId('save-flow-btn')).toBeNull();
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
      { id: 'h2', name: 'IN_PROGRESS', label: 'In Progress', order: 1, exitCriteria: 'hub criteria' },
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

// ── CGLAB-164: the flow editor becomes a vertical step list ─────────────────
// Not a redesign — the same fields, the same behaviour, read in the order the
// screen is actually used. The steps are what this screen is opened to change,
// so they get the height; the description is written once, so it goes to the
// header behind a disclosure. The per-step colour moves from a 16px swatch
// fighting the icon badge for the same 40px to a 4px stripe on the row's left
// edge, which is what makes a per-step colour readable down a list at a glance
// — and the stripe is the hit target that opens the picker. An empty
// exitCriteria stops being a blank field: it is a gate that does not close, so
// it is stated in amber where the step is.
describe('Flow editor — vertical step list (CGLAB-164)', () => {
  // flow-1 so the existing `flow-item-flow-1` sidebar row selects it.
  const VERTICAL_FLOW: Flow = {
    id: 'flow-1',
    name: 'Terraform Flow',
    description: 'A flow with a described purpose',
    steps: [
      { id: 'v1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
      { id: 'v2', name: 'in_review', label: 'In Review', order: 1, exitCriteria: 'Ticket refined', color: '#3b82f6' },
      { id: 'v3', name: 'apply_blocked', label: 'Never apply', order: 2, exitCriteria: '' },
      { id: 'v4', name: 'DONE', label: 'Done', order: 3, exitCriteria: '', isAnchor: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([VERTICAL_FLOW, SAMPLE_FLOW_2]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
  });

  afterEach(() => { cleanup(); });

  const openFlow = async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('steps-columns'));
  };

  // ── The description leaves the middle of the list ─────────────────────────

  it('keeps the description out of the step list — header only, behind a disclosure', async () => {
    await openFlow();
    const header = screen.getByTestId('flow-editor-header');
    const steps = screen.getByTestId('steps-columns');

    // Collapsed by default: written once, rarely reopened.
    expect(screen.queryByTestId('flow-description-input')).toBeNull();

    const toggle = screen.getByTestId('flow-description-toggle');
    expect(header.contains(toggle)).toBe(true);

    fireEvent.click(toggle);
    const textarea = screen.getByTestId('flow-description-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('A flow with a described purpose');
    // It belongs to the header, and the header is not the step list.
    expect(header.contains(textarea)).toBe(true);
    expect(steps.contains(textarea)).toBe(false);
    expect(header.contains(steps)).toBe(false);
    // …and the header comes first in the document.
    expect(header.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses the description again when the disclosure is clicked twice', async () => {
    await openFlow();
    const toggle = screen.getByTestId('flow-description-toggle');
    fireEvent.click(toggle);
    expect(screen.getByTestId('flow-description-input')).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('flow-description-input')).toBeNull();
  });

  it('keeps the version badge in the header meta line, next to the step count', async () => {
    vi.mocked(api.listFlows).mockResolvedValue([{ ...VERTICAL_FLOW, version: '1.0.0' }, SAMPLE_FLOW_2]);
    await openFlow();
    const header = screen.getByTestId('flow-editor-header');
    expect(header.contains(screen.getByTestId('flow-version-badge'))).toBe(true);
    expect(screen.getByTestId('flow-step-count').textContent).toBe('4 steps');
  });

  // ── One row per step, read top to bottom ─────────────────────────────────

  it('lays the steps out as full-width rows, not fixed-width columns', async () => {
    await openFlow();
    expect(screen.getByTestId('steps-columns').className).toContain('flex-col');
    for (const i of [0, 1, 2, 3]) {
      const row = screen.getByTestId(`step-row-${i}`);
      expect(row.className).toContain('w-full');
      expect(row.className).not.toContain('w-52');
      expect(row.className).not.toContain('shrink-0');
    }
  });

  it('numbers each row by its position in the flow, 1-based', async () => {
    await openFlow();
    expect(screen.getByTestId('step-index-0').textContent).toBe('1');
    expect(screen.getByTestId('step-index-1').textContent).toBe('2');
    expect(screen.getByTestId('step-index-2').textContent).toBe('3');
    expect(screen.getByTestId('step-index-3').textContent).toBe('4');
  });

  it('renders the step name as the key it is: monospace, and spelled as stored', async () => {
    await openFlow();
    const nameKey = screen.getByTestId('step-name-1');
    expect(nameKey.className).toContain('font-mono');
    // NOT `uppercase`. The derivation already upcases what it creates, and a
    // legacy key stored as `in_review` displayed as IN_REVIEW is a lie: the
    // server matches a status exactly, so `agenfk update --status IN_REVIEW`
    // would be refused as a flow violation.
    expect(nameKey.className).not.toContain('uppercase');
    // Display-only IS the point now: the key is derived from the label and
    // shown, never typed into. The stored key stays exactly as it was.
    expect(nameKey.tagName).toBe('P');
    expect(nameKey.textContent).toBe('in_review');
  });

  it('states "name · label · exit criteria" once as a column heading, not per step', async () => {
    await openFlow();
    const heading = screen.getByTestId('steps-header-row');
    expect(heading.textContent).toMatch(/name/i);
    expect(heading.textContent).toMatch(/label/i);
    expect(heading.textContent).toMatch(/exit criteria/i);
    // The per-step repetition is gone — it was the same two words six times.
    expect(screen.queryAllByText(/Name \(key\)/i)).toHaveLength(0);
    expect(screen.queryAllByText(/Label \(display\)/i)).toHaveLength(0);
  });

  // ── An empty exit criteria is a gate that does not close ─────────────────

  it('marks an empty exit criteria in amber and says what it means', async () => {
    await openFlow();
    const warning = screen.getByTestId('step-exit-criteria-empty-2');
    expect(warning.textContent).toMatch(/no exit criteria/i);
    expect(warning.textContent).toMatch(/lets work through unchecked/i);
    expect(warning.className).toMatch(/amber/);
  });

  it('does not warn on a step that has criteria', async () => {
    await openFlow();
    expect(screen.queryByTestId('step-exit-criteria-empty-1')).toBeNull();
    expect(screen.getByTestId('step-exit-criteria-1').textContent).toContain('Ticket refined');
  });

  it('does not warn on an anchor — an anchor with no criteria is correct, not unchecked', async () => {
    await openFlow();
    expect(screen.queryByTestId('step-exit-criteria-empty-0')).toBeNull();
    expect(screen.queryByTestId('step-exit-criteria-empty-3')).toBeNull();
    // TODO keeps its editor (CGLAB-109); DONE has no criteria control at all,
    // as in the columns — so its silence is an absence, not an empty field.
    expect(screen.getByTestId('step-exit-criteria-0')).toBeDefined();
    expect(screen.queryByTestId('step-exit-criteria-3')).toBeNull();
  });

  it('clears the warning as soon as criteria are written', async () => {
    await openFlow();
    expect(screen.getByTestId('step-exit-criteria-empty-2')).toBeDefined();
    fireEvent.click(screen.getByTestId('step-exit-criteria-2'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
    fireEvent.change(screen.getByTestId('exit-criteria-editor'), {
      target: { value: 'terraform plan read, nothing destructive in it' },
    });
    fireEvent.click(screen.getByTestId('exit-criteria-save'));
    await waitFor(() => expect(screen.queryByTestId('exit-criteria-editor')).toBeNull());
    expect(screen.queryByTestId('step-exit-criteria-empty-2')).toBeNull();
  });

  // ── The colour moves to the left edge and becomes the hit target ─────────

  it('keeps the rail full-bleed against a square left edge', async () => {
    await openFlow();
    // A 4px box cannot hold an 11px radius — CSS clamps it — so a rounded row
    // corner and a full-height rail cannot both be right. The row's LEFT
    // corners are square so the rail can be flush; the right stay rounded.
    const row = screen.getByTestId('step-row-1');
    expect(row.className).toMatch(/\brounded-r-xl\b/);
    expect(row.className).not.toMatch(/\brounded-xl\b/);
    // And the rail runs the row's full height. The first attempt at the corner
    // problem inset it (`my-3`) and rounded it (`rounded-full`), which turned
    // the rail into a column of loose pills — the opposite of what a per-step
    // colour is for. Neither may come back.
    const stripe = screen.getByTestId('step-color-stripe-1');
    expect(stripe.className).toMatch(/\bself-stretch\b/);
    expect(stripe.className).not.toMatch(/\bmy-\d/);
    expect(stripe.className).not.toMatch(/rounded-full/);
    expect(screen.getByTestId('step-color-swatch-0').className).not.toMatch(/\bmy-\d/);
  });

  it('paints the step colour as a 4px stripe on the row’s left edge', async () => {
    await openFlow();
    const stripe = screen.getByTestId('step-color-stripe-1') as HTMLElement;
    expect(stripe.style.width).toBe('4px');
    expect(stripe.style.backgroundColor).toBeTruthy();
    // Left edge means first child of the row, not a swatch inside the header.
    expect(screen.getByTestId('step-row-1').firstElementChild).toBe(stripe);
  });

  it('gives anchors the same 4px stripe, at the leading edge, without a picker', async () => {
    await openFlow();
    const swatch = screen.getByTestId('step-color-swatch-0') as HTMLElement;
    expect(swatch.style.width).toBe('4px');
    expect(swatch.style.backgroundColor).toBeTruthy();
    expect(screen.getByTestId('step-row-0').firstElementChild).toBe(swatch);
    expect(screen.queryByTestId('step-color-0')).toBeNull();
  });

  it('makes the stripe itself the control that opens the colour picker', async () => {
    await openFlow();
    const stripe = screen.getByTestId('step-color-stripe-1');
    const picker = screen.getByTestId('step-color-1') as HTMLInputElement;
    // The native input is the stripe, not a control beside it.
    expect(stripe.contains(picker)).toBe(true);
    expect(picker.className).toContain('absolute');
    expect(picker.className).toContain('opacity-0');
    expect(picker.className).toContain('cursor-pointer');
    expect(picker.value).toBe('#3b82f6');
  });

  it('repaints the stripe when a new colour is picked', async () => {
    await openFlow();
    fireEvent.change(screen.getByTestId('step-color-1'), { target: { value: '#ff0000' } });
    const stripe = screen.getByTestId('step-color-stripe-1') as HTMLElement;
    expect(stripe.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it('does not offer the picker on a read-only (hub-managed) flow', async () => {
    vi.mocked(api.listFlows).mockResolvedValue([{ ...VERTICAL_FLOW, source: 'hub' }, SAMPLE_FLOW_2]);
    await openFlow();
    expect((screen.getByTestId('step-color-1') as HTMLInputElement).disabled).toBe(true);
  });

  // ── The icon badge keeps its popover and loses the colour fill ───────────

  it('keeps the icon badge a button that opens the 17-icon popover', async () => {
    await openFlow();
    expect(screen.queryByTestId('step-icon-picker-1')).toBeNull();
    const badge = screen.getByTestId('step-icon-btn-1') as HTMLButtonElement;
    expect(badge.tagName).toBe('BUTTON');
    fireEvent.click(badge);
    const picker = screen.getByTestId('step-icon-picker-1');
    expect(picker.querySelectorAll('button')).toHaveLength(17);
  });

  it('commits the chosen icon and closes the popover', async () => {
    await openFlow();
    fireEvent.click(screen.getByTestId('step-icon-btn-1'));
    fireEvent.click(screen.getByTestId('step-icon-option-1-flask'));
    expect(screen.queryByTestId('step-icon-picker-1')).toBeNull();
    // Reopening shows the choice as the pressed option.
    fireEvent.click(screen.getByTestId('step-icon-btn-1'));
    expect(screen.getByTestId('step-icon-option-1-flask').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('step-icon-option-1-zap').getAttribute('aria-pressed')).toBe('false');
  });

  it('saves the chosen icon with the flow', async () => {
    vi.mocked(api.updateFlow).mockResolvedValue({ ...VERTICAL_FLOW });
    await openFlow();
    fireEvent.click(screen.getByTestId('step-icon-btn-1'));
    fireEvent.click(screen.getByTestId('step-icon-option-1-flask'));
    fireEvent.click(screen.getByTestId('save-flow-btn'));
    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.updateFlow).mock.calls[0][1];
    expect(payload.steps?.find((s: any) => s.name === 'in_review')?.icon).toBe('flask');
  });

  it('takes the colour control out from beside the icon badge', async () => {
    await openFlow();
    const picker = screen.getByTestId('step-color-1');
    // The colour control used to be the badge's immediate neighbour, the two
    // splitting 40px, and the glyph lost. It now lives in the rail, and the
    // rail is not next to the badge — it is the row's leading edge.
    expect(screen.getByTestId('step-color-stripe-1').contains(picker)).toBe(true);
    expect(screen.getByTestId('step-row-1').firstElementChild).toBe(
      screen.getByTestId('step-color-stripe-1')
    );
  });

  it('gives the transparent picker a visible focus state', async () => {
    await openFlow();
    // The control went from a bordered 20px input to an invisible overlay, so
    // the focus ring has to be put back on the wrapper it now sits in.
    const stripe = screen.getByTestId('step-color-stripe-1');
    expect(stripe.className).toMatch(/focus-within:ring/);
    // …without a ring offset, whose default colour is white and haloes on dark.
    expect(stripe.className).not.toMatch(/ring-offset-\d/);
  });

  it('sizes the transparent picker explicitly, so it cannot fall back to the colour-well', async () => {
    await openFlow();
    // READ THIS BEFORE WEAKENING IT. jsdom has no layout and no hit-testing,
    // so NOTHING in this file can assert that the rail is actually clickable;
    // the geometry was proved in Chrome (see the card's evidence) and this is
    // only the guard against the specific declaration that broke it. The
    // shipped bug was `-inset-x-1 inset-y-0` with no width or height: an
    // `<input type="color">` with auto dimensions takes its intrinsic ~50x27
    // colour-well size, the box goes over-constrained, `right`/`bottom` are
    // dropped, and the live area ends up half the rail's height and sitting
    // over the step number. Both dimensions must be stated.
    const cls = (screen.getByTestId('step-color-1') as HTMLElement).className;
    expect(cls).toMatch(/\bh-full\b/);
    expect(cls).toMatch(/\bw-6\b/);
    // The horizontal offset is load-bearing too, and for the same reason: the
    // overlay is 24px against a 4px rail, so without pulling it left by 10px
    // the extra 20px lands on the step-number column and clicking the number
    // opens the picker again — measured at 8px of overlap.
    expect(cls).toMatch(/-left-2\.5/);
  });

  // ── Anchors read as scaffolding, not as work ────────────────────────────

  it('draws anchor rows dashed and dimmed, and working rows solid', async () => {
    await openFlow();
    for (const i of [0, 3]) {
      const anchor = screen.getByTestId(`step-row-${i}`);
      expect(anchor.className).toContain('border-dashed');
      expect(anchor.className).toMatch(/opacity-\d+/);
    }
    for (const i of [1, 2]) {
      const working = screen.getByTestId(`step-row-${i}`);
      expect(working.className).not.toContain('border-dashed');
      expect(working.className).not.toMatch(/opacity-\d+/);
    }
  });

  it('still reorders by drag, and renumbers what it moved', async () => {
    await openFlow();
    expect(screen.getByTestId('step-name-1').textContent).toBe('in_review');
    expect(screen.getByTestId('step-name-2').textContent).toBe('apply_blocked');

    const source = screen.getByTestId('step-row-1');
    const target = screen.getByTestId('step-row-2');
    fireEvent.dragStart(source);
    fireEvent.dragOver(target, { dataTransfer: { dropEffect: 'move' } });
    fireEvent.drop(target, { dataTransfer: { dropEffect: 'move' } });
    fireEvent.dragEnd(source);

    // The two working steps have swapped, and the numbers followed them.
    expect(screen.getByTestId('step-name-1').textContent).toBe('apply_blocked');
    expect(screen.getByTestId('step-name-2').textContent).toBe('in_review');
    // (No assertion on step-index here: it renders `index + 1` straight off
    // the map, so it is true of any two-element list and proves nothing.)
    // The anchors did not move.
    expect(screen.getByTestId('step-anchor-lock-0')).toBeDefined();
    expect(screen.getByTestId('step-anchor-lock-3')).toBeDefined();
  });

  it('opens the icon popover upward on the lower rows of a long flow', async () => {
    // The popover lives inside the body's overflow-y-auto scroller, whose
    // scrollbar is hidden, so a downward grid on the last rows is clipped with
    // nothing to say so.
    const LONG: Flow = {
      ...VERTICAL_FLOW,
      steps: [
        { id: 'l0', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `l${i + 1}`,
          name: `step_${i + 1}`,
          label: `Step ${i + 1}`,
          order: i + 1,
          exitCriteria: 'done when done',
        })),
        { id: 'l7', name: 'DONE', label: 'Done', order: 7, exitCriteria: '', isAnchor: true },
      ],
    };
    vi.mocked(api.listFlows).mockResolvedValue([LONG, SAMPLE_FLOW_2]);
    await openFlow();

    fireEvent.click(screen.getByTestId('step-icon-btn-1'));
    expect(screen.getByTestId('step-icon-picker-1').getAttribute('data-placement')).toBe('below');
    expect(screen.getByTestId('step-icon-picker-1').className).toContain('top-7');

    fireEvent.click(screen.getByTestId('step-icon-btn-6'));
    expect(screen.getByTestId('step-icon-picker-6').getAttribute('data-placement')).toBe('above');
    expect(screen.getByTestId('step-icon-picker-6').className).toContain('bottom-7');
  });

  it('flips only past the midpoint, on the smallest flow long enough to need it', async () => {
    // Six steps: indices 0..5, so `index > 3` flips 4 and 5 and nothing else.
    // This is the case that separates the real predicate from `>=`, and from
    // dropping the length guard altogether.
    const SIX: Flow = {
      ...VERTICAL_FLOW,
      steps: [
        { id: 'x0', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `x${i + 1}`, name: `step_${i + 1}`, label: `Step ${i + 1}`,
          order: i + 1, exitCriteria: 'done when done',
        })),
        { id: 'x5', name: 'DONE', label: 'Done', order: 5, exitCriteria: '', isAnchor: true },
      ],
    };
    vi.mocked(api.listFlows).mockResolvedValue([SIX, SAMPLE_FLOW_2]);
    await openFlow();
    for (const [index, expected] of [[1, 'below'], [2, 'below'], [3, 'below'], [4, 'above']] as const) {
      fireEvent.click(screen.getByTestId(`step-icon-btn-${index}`));
      expect(screen.getByTestId(`step-icon-picker-${index}`).getAttribute('data-placement')).toBe(expected);
      fireEvent.click(screen.getByTestId(`step-icon-btn-${index}`));
    }
  });

  it('does not flip on a five-step flow, which still has room below', async () => {
    // The length guard: with `index > length / 2` alone, index 3 of 5 would
    // flip. Five steps is three working rows — the panel has room.
    const FIVE: Flow = {
      ...VERTICAL_FLOW,
      steps: [
        { id: 'f0', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `f${i + 1}`, name: `step_${i + 1}`, label: `Step ${i + 1}`,
          order: i + 1, exitCriteria: 'done when done',
        })),
        { id: 'f4', name: 'DONE', label: 'Done', order: 4, exitCriteria: '', isAnchor: true },
      ],
    };
    vi.mocked(api.listFlows).mockResolvedValue([FIVE, SAMPLE_FLOW_2]);
    await openFlow();
    fireEvent.click(screen.getByTestId('step-icon-btn-3'));
    expect(screen.getByTestId('step-icon-picker-3').getAttribute('data-placement')).toBe('below');
  });

  it('keeps the popover downward on a flow short enough to have room', async () => {
    await openFlow();
    fireEvent.click(screen.getByTestId('step-icon-btn-2'));
    expect(screen.getByTestId('step-icon-picker-2').getAttribute('data-placement')).toBe('below');
  });

  it('marks the collapsed disclosure when there is a description to find', async () => {
    await openFlow();
    // Collapsed is the precondition the name claims: the whole point of the
    // dot is that the description is NOT on screen to be seen.
    expect(screen.queryByTestId('flow-description-input')).toBeNull();
    expect(screen.getByTestId('flow-description-indicator')).toBeDefined();
    // …and it is announced, not just drawn: the dot itself is aria-hidden, so
    // the fact has to reach the toggle's accessible name.
    expect(screen.getByTestId('flow-description-toggle').textContent).toMatch(/this flow has one/i);
  });

  it('leaves the disclosure unmarked when the flow has no description', async () => {
    vi.mocked(api.listFlows).mockResolvedValue([{ ...VERTICAL_FLOW, description: '   ' }, SAMPLE_FLOW_2]);
    await openFlow();
    expect(screen.queryByTestId('flow-description-indicator')).toBeNull();
  });

  it('keeps every anchor guarantee the old columns made', async () => {
    await openFlow();
    // Locked, undeletable, not draggable.
    expect(screen.getByTestId('step-anchor-lock-0')).toBeDefined();
    expect(screen.getByTestId('step-anchor-lock-3')).toBeDefined();
    expect(screen.queryByTestId('delete-step-0')).toBeNull();
    expect(screen.queryByTestId('delete-step-3')).toBeNull();
    expect(screen.getByTestId('step-row-0').getAttribute('draggable')).not.toBe('true');
    expect(screen.getByTestId('step-row-1').getAttribute('draggable')).toBe('true');
    // And nothing was dropped from the working rows.
    expect(screen.getByTestId('delete-step-1')).toBeDefined();
    expect(screen.getByTestId('step-name-1')).toBeDefined();
    expect(screen.getByTestId('step-label-1')).toBeDefined();
    expect(screen.getByTestId('step-exit-criteria-1')).toBeDefined();
    expect(screen.getByTestId('add-step-btn')).toBeDefined();
  });
});

// ── No hardcoded neutral surface colour, on every surface this screen has ───
// Artifact aca414c7 §04, first row: "slate -> tokens; each swap also deletes a
// `dark:` variant". The brand palette is neutral near-black; `slate` is a BLUE
// ramp, which is why this screen read blue beside the rest of the app. And
// every `bg-white dark:bg-slate-900` pair is two fixed decisions the theme
// toggle cannot reach.
//
// EVERY TEST HERE MOUNTS SOMETHING THE OTHERS DO NOT. The first version of
// this block rendered the step list and nothing else, so the popovers, the
// community tab, the delete confirmation and the read-only panel — which is
// where the two brand CTAs live — were migrated without ever being drawn.
// 201 passing tests were not evidence about surfaces no test rendered.
describe('Flow editor — no hardcoded neutral surface colour (aca414c7 §04)', () => {
  const PALETTE_FLOW: Flow = {
    id: 'flow-1',
    name: 'Terraform Flow',
    description: 'A flow with a described purpose',
    steps: [
      { id: 'p1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
      { id: 'p2', name: 'in_review', label: 'In Review', order: 1, exitCriteria: 'Ticket refined', color: '#3b82f6' },
      { id: 'p3', name: 'apply_blocked', label: 'Never apply', order: 2, exitCriteria: '' },
      { id: 'p4', name: 'DONE', label: 'Done', order: 3, exitCriteria: '', isAnchor: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([PALETTE_FLOW, SAMPLE_FLOW_2]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
  });

  afterEach(() => { cleanup(); });

  const open = () => render(
    <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
    { wrapper: wrapper(makeQueryClient()) }
  ).baseElement;

  const openFlow = async () => {
    const root = open();
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('steps-columns'));
    return root;
  };

  // The whole screen in one assertion, listing what it found. A count would
  // say "37 left" and send the reader back to grep; the names say where.
  it('paints the flow list and the step rows from tokens', async () => {
    expect(rawPaletteClasses(await openFlow())).toEqual([]);
  });

  it('paints the sidebar before any flow is selected', async () => {
    const root = open();
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  // Each of these is markup that only exists once something is clicked, and a
  // sweep of the file that renders the row will not render any of them.
  it('paints the exit-criteria editor', async () => {
    const root = await openFlow();
    fireEvent.click(screen.getByTestId('step-exit-criteria-1'));
    await waitFor(() => screen.getByTestId('exit-criteria-editor'));
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  it('paints the icon picker popover', async () => {
    const root = await openFlow();
    fireEvent.click(screen.getByTestId('step-icon-btn-1'));
    await waitFor(() => screen.getByTestId('step-icon-picker-1'));
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  it('paints the colour picker opened from the stripe', async () => {
    const root = await openFlow();
    fireEvent.click(screen.getByTestId('step-color-stripe-1'));
    await waitFor(() => screen.getByTestId('step-color-1'));
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  // The confirmation belongs to the SIDEBAR's delete, not the step's — which
  // is why no step-level click reaches it.
  it('paints the delete confirmation', async () => {
    const root = await openFlow();
    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-1'));
    await waitFor(() => screen.getByTestId('delete-confirm-no'));
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  it('paints the community tab', async () => {
    const root = open();
    await waitFor(() => screen.getByTestId('tab-community'));
    fireEvent.click(screen.getByTestId('tab-community'));
    // The toolbar is a prop the host may not pass, so the branch is pinned by
    // what it REPLACES: My Flows is gone once Community is showing.
    await waitFor(() => expect(screen.queryByTestId('flow-list')).toBeNull());
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  // The read-only panel is where BOTH brand CTAs live, and neither was drawn
  // by any test until this one.
  it('paints the built-in flow panel, where the brand CTAs are', async () => {
    const root = open();
    await waitFor(() => screen.getByTestId('flow-item-__builtin__'));
    fireEvent.click(screen.getByTestId('flow-item-__builtin__'));
    await waitFor(() => screen.getByTestId('editor-panel'));
    expect(rawPaletteClasses(root)).toEqual([]);
  });

  // A dead affordance renders perfectly and passes every assertion about
  // colour. The delete confirmation's No button lost its hover this way,
  // beside a Yes that kept one.
  it('leaves no control whose hover is its own ground', async () => {
    const root = await openFlow();
    fireEvent.click(screen.getByTestId('delete-flow-btn-flow-1'));
    await waitFor(() => screen.getByTestId('delete-confirm-no'));
    expect(deadHoverClasses(root)).toEqual([]);
  });
});

// ── The three paths that carry the risk, through the screen ────────────────
// A derived key made two of these easy to reach and removed the field that
// used to be the escape hatch, so each gets a component test rather than only
// a unit one.
describe('Flow editor — a derived key cannot corrupt a flow', () => {
  const LIVE_FLOW: Flow = {
    id: 'flow-1',
    name: 'Terraform Flow',
    description: '',
    steps: [
      { id: 'l1', name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true },
      { id: 'l2', name: 'in_review', label: 'In Review', order: 1, exitCriteria: 'Ticket refined' },
      { id: 'l3', name: 'apply_blocked', label: 'Never apply', order: 2, exitCriteria: '' },
      { id: 'l4', name: 'DONE', label: 'Done', order: 3, exitCriteria: '', isAnchor: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listFlows).mockResolvedValue([LIVE_FLOW, SAMPLE_FLOW_2]);
    vi.mocked(api.getDefaultFlow).mockResolvedValue(DEFAULT_FLOW);
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
    vi.mocked(api.updateFlow).mockResolvedValue(LIVE_FLOW);
  });

  afterEach(() => { cleanup(); });

  const openFlow = async () => {
    render(
      <FlowEditorModal isOpen={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => screen.getByTestId('flow-item-flow-1'));
    fireEvent.click(screen.getByTestId('flow-item-flow-1'));
    await waitFor(() => screen.getByTestId('steps-columns'));
  };

  /**
   * The blank row, addressed by what makes it blank rather than by arithmetic:
   * Add Step appends AFTER the DONE anchor (bug bfe45d3b) and anchors render
   * no label field, so no index derived from either count is stable.
   */
  const addBlankStep = async (): Promise<string> => {
    fireEvent.click(screen.getByTestId('add-step-btn'));
    const field = await waitFor(() => {
      const empty = (screen.getAllByTestId(/^step-label-\d+$/) as HTMLInputElement[]).find(i => i.value === '');
      if (!empty) throw new Error('Add Step rendered no empty label field');
      return empty;
    });
    return field.getAttribute('data-testid')!.replace('step-label-', '');
  };

  // Two steps, one key: the server finds the FIRST match for an item's status
  // and advances to index+1, which is the same key — so the item verifies
  // into the status it is already in and DONE is unreachable.
  it('refuses a second step whose label derives to an existing key', async () => {
    await openFlow();
    const at = await addBlankStep();
    // Derives to IN_REVIEW, which collides with the stored `in_review`.
    fireEvent.change(screen.getByTestId(`step-label-${at}`), { target: { value: 'In review' } });

    expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true);
    // Pinned to the offending step, not to the flow-level list: the editor
    // routes an issue that names a step to that step's own message.
    expect(screen.getByTestId(`step-name-error-${at}`).textContent).toMatch(/repeats step/i);
  });

  // A label with no letters or digits at all. This is now the ONLY way to
  // reach an empty key, and there is no key field left to repair it in.
  it('blocks Save when the label derives to nothing', async () => {
    await openFlow();
    const at = await addBlankStep();
    fireEvent.change(screen.getByTestId(`step-label-${at}`), { target: { value: '!!!' } });

    expect(screen.getByTestId(`step-name-${at}`).textContent).toBe('from the label');
    expect((screen.getByTestId('save-flow-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  // THE MIGRATION QUESTION, asserted rather than assumed: a round trip through
  // this editor must not upcase the keys of a flow authored before it.
  it('sends a saved flow back with its keys untouched', async () => {
    await openFlow();
    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Terraform Flow v2' } });
    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.updateFlow).mock.calls[0][1] as Partial<Flow>;
    expect(payload.steps!.map(s => s.name)).toEqual(['TODO', 'in_review', 'apply_blocked', 'DONE']);
  });

  // And the rename that started all this: retitling a saved step leaves the
  // status alone, so the items sitting on it stay inside the flow.
  it('keeps a saved key when its label is retitled', async () => {
    await openFlow();
    fireEvent.change(screen.getByTestId('step-label-1'), { target: { value: 'Peer review' } });

    expect(screen.getByTestId('step-name-1').textContent).toBe('in_review');
  });
});
