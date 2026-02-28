/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getReadme: vi.fn(() => Promise.resolve(null)),
    listItems: vi.fn(() => Promise.resolve([])),
    listProjects: vi.fn(() => Promise.resolve([])),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    triggerUpdate: vi.fn(() => Promise.resolve({ jobId: 'job-123' })),
    getUpdateStatus: vi.fn(() => Promise.resolve({ status: 'success', output: 'Done!', exitCode: 0 })),
  },
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg />' })),
  },
}));

// Mock KanbanBoard to avoid deep rendering in App tests
vi.mock('../components/KanbanBoard', () => ({
  KanbanBoard: () => <div data-testid="kanban-board">KanbanBoard</div>,
}));

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── App ──────────────────────────────────────────────────────────────────────

describe('App', () => {
  it('should render without crashing', async () => {
    const App = (await import('../App')).default;
    const qc = makeQueryClient();
    render(<App />, { wrapper: wrapper(qc) });
    expect(screen.getByTestId('kanban-board')).toBeDefined();
  });
});

// ─── WhatsNewModal ─────────────────────────────────────────────────────────────

import { WhatsNewModal } from '../components/WhatsNewModal';

describe('WhatsNewModal', () => {
  it('should not render when isOpen is false', () => {
    const qc = makeQueryClient();
    const { container } = render(
      <WhatsNewModal isOpen={false} onClose={() => {}} />,
      { wrapper: wrapper(qc) },
    );
    expect(container.firstChild).toBeNull();
  });

  it('should render the modal when isOpen is true (loading state)', () => {
    (api.getLatestRelease as any).mockReturnValue(new Promise(() => {})); // never resolves
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    expect(screen.getByText(/What's New/i)).toBeDefined();
    expect(screen.getByText(/Loading release notes/i)).toBeDefined();
  });

  it('should render release data when loaded', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      name: 'Big Release',
      body: 'Lots of changes',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/foo/bar/releases/v2.0.0',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    await waitFor(() => {
      expect(screen.getByText('Big Release')).toBeDefined();
    });
  });

  it('should call onClose when close button is clicked', () => {
    (api.getLatestRelease as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={onClose} />, {
      wrapper: wrapper(qc),
    });
    const closeBtn = document.querySelector('button');
    if (closeBtn) fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose on Escape key', () => {
    (api.getLatestRelease as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={onClose} />, {
      wrapper: wrapper(qc),
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('should not call onClose on non-Escape key', () => {
    (api.getLatestRelease as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={onClose} />, {
      wrapper: wrapper(qc),
    });
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should call onClose when backdrop is clicked', () => {
    (api.getLatestRelease as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    const { container } = render(
      <WhatsNewModal isOpen={true} onClose={onClose} />,
      { wrapper: wrapper(qc) },
    );
    // Click the outer overlay div (first child of portal)
    const overlay = container.querySelector('.fixed');
    if (overlay) fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('should show "Unable to load release notes" when no data', async () => {
    (api.getLatestRelease as any).mockResolvedValue(null);
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    await waitFor(() => {
      expect(screen.getByText(/Unable to load release notes/i)).toBeDefined();
    });
  });

  it('should show update available when version is newer', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      name: 'Big Release',
      body: 'Changes',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/foo/bar/releases/v2.0.0',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    await waitFor(() => {
      expect(screen.getByText(/v2.0.0 available/i)).toBeDefined();
    });
  });

  it('should NOT show update available when current version is newer', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '1.0.0',
      name: 'Old Release',
      body: 'Old stuff',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/foo/bar/releases/v1.0.0',
      currentVersion: '2.0.0',
    });
    const qc = makeQueryClient();
    render(<WhatsNewModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    await waitFor(() => {
      expect(screen.queryByText(/available/i)).toBeNull();
    });
  });
});

// ─── ReadmeModal ───────────────────────────────────────────────────────────────

import { ReadmeModal } from '../components/ReadmeModal';

describe('ReadmeModal', () => {
  it('should not render when isOpen is false', () => {
    const qc = makeQueryClient();
    const { container } = render(
      <ReadmeModal isOpen={false} onClose={() => {}} />,
      { wrapper: wrapper(qc) },
    );
    expect(container.firstChild).toBeNull();
  });

  it('should render when isOpen is true (loading state)', () => {
    (api.getReadme as any).mockReturnValue(new Promise(() => {}));
    const qc = makeQueryClient();
    render(<ReadmeModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    expect(screen.getByText(/Project README/i)).toBeDefined();
    expect(screen.getByText(/Loading documentation/i)).toBeDefined();
  });

  it('should render readme content when loaded', async () => {
    (api.getReadme as any).mockResolvedValue({ content: '# Hello World' });
    const qc = makeQueryClient();
    render(<ReadmeModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeDefined();
    });
  });

  it('should show unable to load when readme is null', async () => {
    (api.getReadme as any).mockResolvedValue(null);
    const qc = makeQueryClient();
    render(<ReadmeModal isOpen={true} onClose={() => {}} />, {
      wrapper: wrapper(qc),
    });
    await waitFor(() => {
      expect(screen.getByText(/Unable to load README/i)).toBeDefined();
    });
  });

  it('should call onClose when Close button is clicked', () => {
    (api.getReadme as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    render(<ReadmeModal isOpen={true} onClose={onClose} />, {
      wrapper: wrapper(qc),
    });
    const closeBtn = screen.getByText('Close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose on Escape key', () => {
    (api.getReadme as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    render(<ReadmeModal isOpen={true} onClose={onClose} />, {
      wrapper: wrapper(qc),
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('should not call onClose on non-Escape key', () => {
    (api.getReadme as any).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    const qc = makeQueryClient();
    render(<ReadmeModal isOpen={true} onClose={onClose} />, {
      wrapper: wrapper(qc),
    });
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ─── ReleaseReminder ──────────────────────────────────────────────────────────

import { ReleaseReminder } from '../components/ReleaseReminder';

describe('ReleaseReminder', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should return null when no release data', async () => {
    (api.getLatestRelease as any).mockResolvedValue(null);
    const qc = makeQueryClient();
    const { container } = render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      // After query resolves, still null because no release
      expect(container.firstChild).toBeNull();
    });
  });

  it('should return null when release is not newer', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '1.0.0',
      tagName: 'v1.0.0',
      name: 'Same',
      body: '',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    const { container } = render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('should show the rocket button when a newer release is available', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Big Release',
      body: 'Changes!',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      expect(screen.getByTitle(/New release available/i)).toBeDefined();
    });
  });

  it('should open modal when rocket button is clicked', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Big Release',
      body: 'Changes!',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      expect(screen.getByTitle(/New release available/i)).toBeDefined();
    });
    fireEvent.click(screen.getByTitle(/New release available/i));
    expect(screen.getByText(/New Release Available/i)).toBeDefined();
  });

  it('should dismiss and hide when Dismiss button is clicked', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Big Release',
      body: 'Changes!',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    const { container } = render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      fireEvent.click(screen.getByTitle(/New release available/i));
    });
    fireEvent.click(screen.getByText('Dismiss'));
    // After dismiss, the button should be gone (isDismissed matches version)
    await waitFor(() => {
      expect(container.querySelector('button[title]')).toBeNull();
    });
    expect(localStorage.getItem('agenfk_dismissed_release')).toBe('2.0.0');
  });

  it('should close modal when X button is clicked', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Big Release',
      body: 'Changes!',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      fireEvent.click(screen.getByTitle(/New release available/i));
    });
    expect(screen.getByText(/New Release Available/i)).toBeDefined();
    // Click the X close button (aria-hidden or button with X icon)
    const xButton = document.querySelector('.fixed button');
    if (xButton) fireEvent.click(xButton);
    expect(screen.queryByText(/New Release Available/i)).toBeNull();
  });

  it('should trigger update when Update Now is clicked', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Big Release',
      body: 'Changes!',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    (api.triggerUpdate as any).mockResolvedValue({ jobId: 'job-123' });
    (api.getUpdateStatus as any).mockResolvedValue({ status: 'running', output: 'Installing...', exitCode: undefined });
    const qc = makeQueryClient();
    render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      fireEvent.click(screen.getByTitle(/New release available/i));
    });
    fireEvent.click(screen.getByText('Update Now'));
    await waitFor(() => {
      expect(api.triggerUpdate).toHaveBeenCalled();
    });
    // After triggerUpdate, poll state changes to 'running'
    await waitFor(() => {
      expect(screen.getByText(/Updating AgenFK/i)).toBeDefined();
    });
  });

  it('should show error state when update fails', async () => {
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Big Release',
      body: 'Changes!',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    (api.triggerUpdate as any).mockRejectedValue(new Error('server error'));
    const qc = makeQueryClient();
    render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      fireEvent.click(screen.getByTitle(/New release available/i));
    });
    fireEvent.click(screen.getByText('Update Now'));
    await waitFor(() => {
      const errorElements = screen.queryAllByText(/Update Failed/i);
      expect(errorElements.length).toBeGreaterThan(0);
    });
  });

  it('should return null if dismissed version matches', async () => {
    localStorage.setItem('agenfk_dismissed_release', '2.0.0');
    (api.getLatestRelease as any).mockResolvedValue({
      version: '2.0.0',
      tagName: 'v2.0.0',
      name: 'Dismissed',
      body: '',
      publishedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/release',
      currentVersion: '1.0.0',
    });
    const qc = makeQueryClient();
    const { container } = render(<ReleaseReminder />, { wrapper: wrapper(qc) });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});
