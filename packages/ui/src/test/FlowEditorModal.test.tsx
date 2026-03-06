/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

const SAMPLE_FLOW: Flow = {
  id: 'flow-1',
  name: 'My Flow',
  description: 'A sample flow',
  projectId: PROJECT_ID,
  steps: [
    { id: 's1', name: 'todo', label: 'To Do', order: 0, exitCriteria: 'Ticket refined', isSpecial: false },
    { id: 's2', name: 'done', label: 'Done', order: 1, exitCriteria: '', isSpecial: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('FlowEditorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it('renders nothing when open=false', () => {
    render(
      <FlowEditorModal open={false} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.queryByTestId('flow-editor-modal')).toBeNull();
  });

  it('renders the modal in create mode when no flow is provided', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('flow-editor-modal')).toBeDefined();
    expect(screen.getByText('New Flow')).toBeDefined();
  });

  it('renders modal in edit mode when a flow is provided', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByText('Edit Flow')).toBeDefined();
    expect((screen.getByTestId('flow-name-input') as HTMLInputElement).value).toBe('My Flow');
    expect((screen.getByTestId('flow-description-input') as HTMLTextAreaElement).value).toBe('A sample flow');
  });

  it('renders the correct number of step rows for an existing flow', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.getByTestId('step-row-1')).toBeDefined();
    expect(screen.queryByTestId('step-row-2')).toBeNull();
  });

  it('seeds step fields from the existing flow', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect((screen.getByTestId('step-name-0') as HTMLInputElement).value).toBe('todo');
    expect((screen.getByTestId('step-label-0') as HTMLInputElement).value).toBe('To Do');
    expect((screen.getByTestId('step-exit-criteria-0') as HTMLTextAreaElement).value).toBe('Ticket refined');
    expect((screen.getByTestId('step-is-special-0') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('step-is-special-1') as HTMLInputElement).checked).toBe(true);
  });

  // ── Add / Remove steps ────────────────────────────────────────────────────

  it('adds a blank step when Add Step is clicked', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    // Create mode starts with 1 step
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.queryByTestId('step-row-1')).toBeNull();

    fireEvent.click(screen.getByTestId('add-step-btn'));
    expect(screen.getByTestId('step-row-1')).toBeDefined();
  });

  it('removes a non-special step when Delete is clicked', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('step-row-0')).toBeDefined();
    expect(screen.getByTestId('step-row-1')).toBeDefined();

    // Delete the first (non-special) step
    fireEvent.click(screen.getByTestId('delete-step-0'));
    expect(screen.queryByTestId('step-row-1')).toBeNull();
    // Only one row remains
    expect(screen.getByTestId('step-row-0')).toBeDefined();
  });

  it('delete button is disabled for special steps', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    const deleteSpecialBtn = screen.getByTestId('delete-step-1') as HTMLButtonElement;
    expect(deleteSpecialBtn.disabled).toBe(true);
  });

  // ── Save ──────────────────────────────────────────────────────────────────

  it('calls createFlow with correct payload on Save in create mode', async () => {
    vi.mocked(api.createFlow).mockResolvedValue({ ...SAMPLE_FLOW, id: 'new-flow' });
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Sprint Flow' } });
    fireEvent.change(screen.getByTestId('step-name-0'), { target: { value: 'todo' } });
    fireEvent.change(screen.getByTestId('step-label-0'), { target: { value: 'To Do' } });

    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.createFlow).mock.calls[0][0];
    expect(call.name).toBe('Sprint Flow');
    expect(call.projectId).toBe(PROJECT_ID);
    expect(Array.isArray(call.steps)).toBe(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('calls updateFlow with the flow id on Save in edit mode', async () => {
    vi.mocked(api.updateFlow).mockResolvedValue(SAMPLE_FLOW);
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'Updated Flow' } });
    fireEvent.click(screen.getByTestId('save-flow-btn'));

    await waitFor(() => expect(api.updateFlow).toHaveBeenCalledWith('flow-1', expect.objectContaining({ name: 'Updated Flow' })));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Save button is disabled when flow name is empty', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    const saveBtn = screen.getByTestId('save-flow-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  // ── "Use this Flow" ───────────────────────────────────────────────────────

  it('calls setProjectFlow with existing flow id when Use this Flow is clicked', async () => {
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() =>
      expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'flow-1')
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('creates flow then calls setProjectFlow when Use this Flow is clicked in create mode', async () => {
    const newFlow = { ...SAMPLE_FLOW, id: 'created-flow' };
    vi.mocked(api.createFlow).mockResolvedValue(newFlow);
    vi.mocked(api.setProjectFlow).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.change(screen.getByTestId('flow-name-input'), { target: { value: 'New Sprint Flow' } });
    fireEvent.click(screen.getByTestId('use-flow-btn'));

    await waitFor(() => expect(api.createFlow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.setProjectFlow).toHaveBeenCalledWith(PROJECT_ID, 'created-flow'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Use this Flow button is disabled when flow name is empty', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    const useBtn = screen.getByTestId('use-flow-btn') as HTMLButtonElement;
    expect(useBtn.disabled).toBe(true);
  });

  // ── Cancel ────────────────────────────────────────────────────────────────

  it('Cancel button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('X button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    render(
      <FlowEditorModal open={true} onClose={onClose} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Step field editing ────────────────────────────────────────────────────

  it('updates step name field when user types', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    const nameInput = screen.getByTestId('step-name-0') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'in_review' } });
    expect(nameInput.value).toBe('in_review');
  });

  it('toggles isSpecial checkbox for a non-special step', () => {
    render(
      <FlowEditorModal open={true} onClose={() => {}} flow={SAMPLE_FLOW} projectId={PROJECT_ID} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    const checkbox = screen.getByTestId('step-is-special-0') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });
});
