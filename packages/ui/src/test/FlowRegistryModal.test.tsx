/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FlowRegistryModal } from '../components/FlowRegistryModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { Flow, RegistryFlow } from '../types';

vi.mock('../api', () => ({
  api: {
    browseRegistry: vi.fn(),
    installFromRegistry: vi.fn(),
    publishToRegistry: vi.fn(),
    listFlows: vi.fn(),
  },
}));

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

const SAMPLE_REGISTRY_FLOWS: RegistryFlow[] = [
  {
    filename: 'scrum.json',
    name: 'Scrum Flow',
    author: 'agenfk',
    version: '1.0.0',
    stepCount: 5,
    description: 'A standard Scrum workflow',
  },
  {
    filename: 'kanban.json',
    name: 'Kanban Flow',
    author: 'community',
    version: '2.1.0',
    stepCount: 3,
    description: 'A lean Kanban workflow',
  },
];

const SAMPLE_LOCAL_FLOW: Flow = {
  id: 'local-flow-1',
  name: 'My Custom Flow',
  description: 'A custom flow I made',
  projectId: 'proj-abc',
  steps: [
    { id: 's1', name: 'todo', label: 'To Do', order: 0, isSpecial: false },
    { id: 's2', name: 'done', label: 'Done', order: 1, isSpecial: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('FlowRegistryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.browseRegistry).mockResolvedValue(SAMPLE_REGISTRY_FLOWS);
    vi.mocked(api.listFlows).mockResolvedValue([SAMPLE_LOCAL_FLOW]);
    vi.mocked(api.installFromRegistry).mockResolvedValue({ ...SAMPLE_LOCAL_FLOW, id: 'installed-1', name: 'Scrum Flow' });
    vi.mocked(api.publishToRegistry).mockResolvedValue({ url: 'https://github.com/agenfk-flows/registry/blob/main/flows/my-custom-flow.json' });
  });

  afterEach(() => {
    cleanup();
  });

  // ── Visibility ────────────────────────────────────────────────────────────

  it('renders nothing when open=false', () => {
    render(
      <FlowRegistryModal open={false} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.queryByTestId('flow-registry-modal')).toBeNull();
  });

  it('renders the modal when open=true', () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('flow-registry-modal')).toBeDefined();
  });

  it('calls onClose when X button is clicked', () => {
    const onClose = vi.fn();
    render(
      <FlowRegistryModal open={true} onClose={onClose} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <FlowRegistryModal open={true} onClose={onClose} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Tabs ──────────────────────────────────────────────────────────────────

  it('renders all three tabs', () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.getByTestId('tab-browse')).toBeDefined();
    expect(screen.getByTestId('tab-my-flows')).toBeDefined();
    expect(screen.getByTestId('tab-about')).toBeDefined();
  });

  it('Browse tab is active by default', () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    // The browse tab should have the active style (border-indigo-500 class)
    const browseTab = screen.getByTestId('tab-browse');
    expect(browseTab.className).toContain('border-indigo-500');
  });

  it('switches to My Flows tab on click', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    await waitFor(() => expect(screen.getByTestId('my-flows-list')).toBeDefined());
  });

  it('switches to About tab on click', () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-about'));
    expect(screen.getByTestId('about-tab')).toBeDefined();
  });

  // ── Browse Tab ────────────────────────────────────────────────────────────

  it('Browse tab calls browseRegistry and renders rows', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('registry-table')).toBeDefined());
    expect(screen.getByTestId('registry-row-0')).toBeDefined();
    expect(screen.getByTestId('registry-row-1')).toBeDefined();
    expect(screen.getByText('Scrum Flow')).toBeDefined();
    expect(screen.getByText('Kanban Flow')).toBeDefined();
  });

  it('renders Install button for each registry row', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('install-btn-0')).toBeDefined());
    expect(screen.getByTestId('install-btn-1')).toBeDefined();
  });

  it('clicking Install shows confirmation panel', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('install-btn-0')).toBeDefined());
    fireEvent.click(screen.getByTestId('install-btn-0'));
    expect(screen.getByTestId('install-confirm-panel')).toBeDefined();
    expect(screen.getByText(/Install "Scrum Flow"/)).toBeDefined();
  });

  it('clicking Confirm Install calls installFromRegistry with correct filename', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('install-btn-0')).toBeDefined());
    fireEvent.click(screen.getByTestId('install-btn-0'));
    expect(screen.getByTestId('install-confirm-panel')).toBeDefined();

    fireEvent.click(screen.getByTestId('confirm-install-btn'));
    await waitFor(() => expect(api.installFromRegistry).toHaveBeenCalledWith('scrum.json'));
  });

  it('shows success banner after successful install', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('install-btn-0')).toBeDefined());
    fireEvent.click(screen.getByTestId('install-btn-0'));
    fireEvent.click(screen.getByTestId('confirm-install-btn'));

    await waitFor(() => expect(screen.getByTestId('install-success-banner')).toBeDefined());
    expect(screen.getByText(/Scrum Flow.*installed successfully/)).toBeDefined();
  });

  it('shows error message when install fails', async () => {
    vi.mocked(api.installFromRegistry).mockRejectedValue(new Error('Network error'));
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('install-btn-0')).toBeDefined());
    fireEvent.click(screen.getByTestId('install-btn-0'));
    fireEvent.click(screen.getByTestId('confirm-install-btn'));

    await waitFor(() => expect(screen.getByTestId('install-error')).toBeDefined());
  });

  it('search filters registry rows', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('registry-table')).toBeDefined());

    fireEvent.change(screen.getByTestId('registry-search-input'), {
      target: { value: 'kanban' },
    });

    await waitFor(() => {
      expect(screen.queryByText('Scrum Flow')).toBeNull();
      expect(screen.getByText('Kanban Flow')).toBeDefined();
    });
  });

  it('shows empty state when no registry flows match search', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByTestId('registry-table')).toBeDefined());

    fireEvent.change(screen.getByTestId('registry-search-input'), {
      target: { value: 'xxxxxxxxnotexisting' },
    });

    await waitFor(() => expect(screen.getByText(/No flows match your search/)).toBeDefined());
  });

  it('shows error state when browseRegistry fails', async () => {
    vi.mocked(api.browseRegistry).mockRejectedValue(new Error('Registry unavailable'));
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    await waitFor(() => expect(screen.getByText(/Registry unavailable/)).toBeDefined());
  });

  // ── My Flows Tab ──────────────────────────────────────────────────────────

  it('My Flows tab renders local flows via listFlows', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));

    await waitFor(() => expect(screen.getByTestId('my-flows-list')).toBeDefined());
    expect(screen.getByText('My Custom Flow')).toBeDefined();
    expect(screen.getByText('A custom flow I made')).toBeDefined();
  });

  it('My Flows tab shows empty message when no flows exist', async () => {
    vi.mocked(api.listFlows).mockResolvedValue([]);
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));

    await waitFor(() => expect(screen.getByText(/No flows yet/)).toBeDefined());
  });

  it('clicking Publish button opens the publish form', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    await waitFor(() => expect(screen.getByTestId('publish-btn-0')).toBeDefined());

    fireEvent.click(screen.getByTestId('publish-btn-0'));
    expect(screen.getByTestId('publish-form-0')).toBeDefined();
    expect(screen.getByTestId('github-token-input-0')).toBeDefined();
  });

  it('Submit Publish calls publishToRegistry with the flow id and token', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    await waitFor(() => expect(screen.getByTestId('publish-btn-0')).toBeDefined());

    fireEvent.click(screen.getByTestId('publish-btn-0'));
    fireEvent.change(screen.getByTestId('github-token-input-0'), {
      target: { value: 'ghp_testtoken' },
    });
    fireEvent.click(screen.getByTestId('submit-publish-btn-0'));

    await waitFor(() =>
      expect(api.publishToRegistry).toHaveBeenCalledWith('local-flow-1', 'ghp_testtoken')
    );
  });

  it('shows published URL after successful publish', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    await waitFor(() => expect(screen.getByTestId('publish-btn-0')).toBeDefined());

    fireEvent.click(screen.getByTestId('publish-btn-0'));
    fireEvent.change(screen.getByTestId('github-token-input-0'), {
      target: { value: 'ghp_testtoken' },
    });
    fireEvent.click(screen.getByTestId('submit-publish-btn-0'));

    await waitFor(() => expect(screen.getByTestId('publish-success-0')).toBeDefined());
    expect(screen.getByText(/Published!/)).toBeDefined();
  });

  it('Submit Publish button is disabled when token is empty', async () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    await waitFor(() => expect(screen.getByTestId('publish-btn-0')).toBeDefined());

    fireEvent.click(screen.getByTestId('publish-btn-0'));
    const submitBtn = screen.getByTestId('submit-publish-btn-0') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('shows error state when publishToRegistry fails', async () => {
    vi.mocked(api.publishToRegistry).mockRejectedValue(new Error('Permission denied'));
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-my-flows'));
    await waitFor(() => expect(screen.getByTestId('publish-btn-0')).toBeDefined());

    fireEvent.click(screen.getByTestId('publish-btn-0'));
    fireEvent.change(screen.getByTestId('github-token-input-0'), {
      target: { value: 'ghp_bad' },
    });
    fireEvent.click(screen.getByTestId('submit-publish-btn-0'));

    await waitFor(() => expect(screen.getByTestId('publish-error-0')).toBeDefined());
  });

  // ── About Tab ─────────────────────────────────────────────────────────────

  it('About tab renders registry link', () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-about'));
    expect(screen.getByTestId('about-tab')).toBeDefined();
    const link = screen.getByTestId('registry-repo-link') as HTMLAnchorElement;
    expect(link.href).toContain('github.com/agenfk-flows/registry');
  });

  it('About tab mentions AGENFK_REGISTRY_TOKEN', () => {
    render(
      <FlowRegistryModal open={true} onClose={() => {}} />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    fireEvent.click(screen.getByTestId('tab-about'));
    expect(screen.getByText(/AGENFK_REGISTRY_TOKEN/)).toBeDefined();
  });
});
