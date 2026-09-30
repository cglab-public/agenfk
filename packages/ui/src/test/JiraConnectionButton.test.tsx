/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { JiraConnectionButton } from '../components/JiraConnectionButton';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getJiraStatus: vi.fn(),
    disconnectJira: vi.fn(),
  },
}));

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

describe('JiraConnectionButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset URL to no params
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders "Connect JIRA" button when configured but not connected', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: true, connected: false });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    expect(await screen.findByTestId('jira-connect')).toBeDefined();
    expect(screen.getByText('Connect JIRA')).toBeDefined();
  });

  it('renders disabled unconfigured button when configured:false', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: false, connected: false });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    const btn = await screen.findByTestId('jira-unconfigured');
    expect(btn).toBeDefined();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect((btn as HTMLButtonElement).title).toContain('agenfk jira setup');
  });

  it('renders connected chip and disconnect button when connected', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({
      configured: true,
      connected: true,
      cloudId: 'cloud-1',
      email: 'user@example.com',
    });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    expect(await screen.findByTestId('jira-connected')).toBeDefined();
    expect(screen.getByText('JIRA')).toBeDefined();
    expect(screen.getByLabelText('Disconnect JIRA')).toBeDefined();
  });

  it('calls disconnectJira and refreshes status on disconnect click', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: true, connected: true });
    vi.mocked(api.disconnectJira).mockResolvedValue(undefined);

    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    const disconnectBtn = await screen.findByLabelText('Disconnect JIRA');
    fireEvent.click(disconnectBtn);

    await waitFor(() => expect(api.disconnectJira).toHaveBeenCalledTimes(1));
  });

  it('shows success toast and strips ?jira=connected from URL', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: true, connected: true });
    window.history.replaceState({}, '', '/?jira=connected');

    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('JIRA connected successfully!')).toBeDefined();
    expect(window.location.search).toBe('');
  });

  it('shows error toast and strips ?jira=error from URL', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: false, connected: false });
    window.history.replaceState({}, '', '/?jira=error&reason=token_exchange_failed');

    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/authentication failed/i)).toBeDefined();
    expect(window.location.search).toBe('');
  });

  it('shows "agenfk jira setup" hint in error toast for server_misconfigured', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: false, connected: false });
    window.history.replaceState({}, '', '/?jira=error&reason=server_misconfigured');

    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/agenfk jira setup/i)).toBeDefined();
  });

  it('dismisses toast on close button click', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ configured: true, connected: false });
    window.history.replaceState({}, '', '/?jira=connected');

    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    const alert = await screen.findByRole('alert');
    expect(alert).toBeDefined();

    fireEvent.click(screen.getByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows loading spinner when getJiraStatus throws (server unavailable)', async () => {
    vi.mocked(api.getJiraStatus).mockRejectedValue(new Error('Network Error'));
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });

    // Should show loading/spinner, not "Connect JIRA"
    expect(await screen.findByTestId('jira-loading')).toBeDefined();
  });
});

/**
 * A hub-joined installation (CGLAB-412): the hub admin configures the org's
 * Atlassian app; each user connects their OWN JIRA from the board, through
 * the hub. So Connect and Disconnect work as locally - the server routes them
 * via the hub - and only a hub with no app at all sends the user to an admin.
 */
describe('JiraConnectionButton on a hub-joined installation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => cleanup());

  it('shows the user\'s connection through the hub, with a Disconnect control', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({
      source: 'hub', configured: true, connected: true, cloudUrl: 'https://acme.atlassian.net', email: 'alice@acme.test',
    });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });
    const chip = await screen.findByTestId('jira-connected');
    expect(chip.textContent).toContain('JIRA');
    expect(chip.getAttribute('title') ?? '').toMatch(/hub/i);
    expect(chip.getAttribute('title') ?? '').toContain('alice@acme.test');
    expect(screen.getByLabelText('Disconnect JIRA')).toBeDefined();
  });

  it('with no JIRA app on the hub, says to ask a hub admin and offers no Connect', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ source: 'hub', configured: false, connected: false });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });
    const btn = await screen.findByTestId('jira-hub-unconnected');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect((btn as HTMLButtonElement).title).toMatch(/hub admin/i);
    expect((btn as HTMLButtonElement).title).not.toContain('agenfk jira setup');
    expect(screen.queryByTestId('jira-connect')).toBeNull();
  });

  it('a rejected hub key points at hub login rather than a hub admin', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ source: 'hub', configured: false, connected: false, reason: 'hub_auth_failed' });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });
    const btn = await screen.findByTestId('jira-hub-unconnected');
    expect((btn as HTMLButtonElement).title).toContain('agenfk hub login');
  });

  it('with the hub app there but no connection yet, offers Connect JIRA (routed through the hub)', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ source: 'hub', configured: true, connected: false });
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });
    expect(await screen.findByTestId('jira-connect')).toBeDefined();
    expect(screen.queryByTestId('jira-hub-unconnected')).toBeNull();
  });

  it('gives every hub callback reason a sentence, never the raw code', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ source: 'hub', configured: true, connected: false });
    for (const reason of ['no_accessible_site', 'missing_code', 'not_configured', 'jira_unreachable', 'key_not_personal']) {
      window.history.replaceState({}, '', `/?jira=error&reason=${reason}`);
      const { unmount } = render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });
      const toast = await screen.findByTestId('jira-toast');
      expect(toast.textContent, reason).not.toContain(reason);
      unmount();
    }
  });

  it('explains hub-specific connect failures from the callback', async () => {
    vi.mocked(api.getJiraStatus).mockResolvedValue({ source: 'hub', configured: true, connected: false });
    window.history.replaceState({}, '', '/?jira=error&reason=completion_key_mismatch');
    render(<JiraConnectionButton />, { wrapper: wrapper(makeQueryClient()) });
    const toast = await screen.findByTestId('jira-toast');
    expect(toast.textContent).toMatch(/different installation|start again/i);
    expect(toast.textContent).not.toContain('completion_key_mismatch');
  });
});
