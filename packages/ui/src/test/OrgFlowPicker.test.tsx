/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { OrgFlowPicker } from '../components/OrgFlowPicker';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getOrgAvailableFlows: vi.fn(),
    selectOrgFlow: vi.fn(),
  },
}));

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

const FLOWS = [
  { id: 'flow-default', name: 'Default Flow', steps: [] },
  { id: 'flow-tdd', name: 'TDD Flow', steps: [] },
];

describe('OrgFlowPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when open=false', () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    render(<OrgFlowPicker open={false} onClose={() => {}} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    expect(screen.queryByTestId('org-flow-picker')).toBeNull();
  });

  it('lists org-available flows and marks the org default', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    render(<OrgFlowPicker open onClose={() => {}} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    expect(await screen.findByText('Default Flow')).toBeInTheDocument();
    expect(screen.getByText('TDD Flow')).toBeInTheDocument();
    expect(screen.getByTestId('org-flow-default-flow-default')).toBeInTheDocument();
  });

  it('marks the currently active flow as selected', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    render(<OrgFlowPicker open onClose={() => {}} projectId="p1" activeFlowId="flow-tdd" />, { wrapper: wrapper(makeQueryClient()) });
    expect(await screen.findByTestId('org-flow-selected-flow-tdd')).toBeInTheDocument();
  });

  it('shows a message when the hub is not configured', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: false });
    render(<OrgFlowPicker open onClose={() => {}} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    expect(await screen.findByText(/Hub is not configured/i)).toBeInTheDocument();
  });

  it('shows a message when there are no org-available flows', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: [], defaultFlowId: null, hubEnabled: true });
    render(<OrgFlowPicker open onClose={() => {}} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    expect(await screen.findByText(/No org-available flows/i)).toBeInTheDocument();
  });

  it('calls selectOrgFlow with (projectId, flowId) when a flow is chosen', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    vi.mocked(api.selectOrgFlow).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<OrgFlowPicker open onClose={onClose} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    fireEvent.click(await screen.findByTestId('select-org-flow-flow-tdd'));
    await waitFor(() => expect(api.selectOrgFlow).toHaveBeenCalledWith('p1', 'flow-tdd'));
  });

  // FIX 5a — mutation error shows banner and does NOT close
  it('shows mutation error banner and does not call onClose on select failure', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    vi.mocked(api.selectOrgFlow).mockRejectedValue({ response: { data: { error: 'Hub unreachable' } } });
    const onClose = vi.fn();
    render(<OrgFlowPicker open onClose={onClose} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    fireEvent.click(await screen.findByTestId('select-org-flow-flow-tdd'));
    await waitFor(() => {
      const banner = screen.getByTestId('org-flow-select-error');
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent('Hub unreachable');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  // FIX 5b — successful select calls onClose
  it('calls onClose on successful select', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    vi.mocked(api.selectOrgFlow).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<OrgFlowPicker open onClose={onClose} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    fireEvent.click(await screen.findByTestId('select-org-flow-flow-tdd'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // FIX 5c — active flow button is disabled
  it('disables the select button for the currently active flow', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockResolvedValue({ flows: FLOWS, defaultFlowId: 'flow-default', hubEnabled: true });
    render(<OrgFlowPicker open onClose={() => {}} projectId="p1" activeFlowId="flow-tdd" />, { wrapper: wrapper(makeQueryClient()) });
    const btn = await screen.findByTestId('select-org-flow-flow-tdd');
    expect(btn).toBeDisabled();
  });

  // FIX 5d — load error surfaces server message
  it('surfaces server error detail on load failure', async () => {
    vi.mocked(api.getOrgAvailableFlows).mockRejectedValue({ response: { data: { error: 'Hub returned 403' } } });
    render(<OrgFlowPicker open onClose={() => {}} projectId="p1" />, { wrapper: wrapper(makeQueryClient()) });
    const loadError = await screen.findByTestId('org-flow-load-error');
    expect(loadError).toHaveTextContent('Hub returned 403');
  });
});