/**
 * @vitest-environment jsdom
 *
 * A JIRA reference with NO browse URL must still be visible.
 *
 * Both badges were gated on `item.externalUrl &&`. That was fine while the only
 * writers were the JIRA and GitHub importers, which always produce a URL. It
 * stopped being fine when cards became linkable directly: linking while JIRA is
 * disconnected stores the key with no URL by design — the offline/CI mode the
 * shipped docs advertise — so those cards carried a reference that rendered
 * nowhere on the board or in the detail modal.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { KanbanBoard } from '../components/KanbanBoard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { ItemType, Status } from '../types';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});

if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollTo = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

const FLOW = {
  id: 'default', name: 'Default Flow', projectId: '__builtin__',
  steps: [
    { id: 's-todo', name: 'TODO', label: 'TODO', order: 0 },
    { id: 's-done', name: 'DONE', label: 'DONE', order: 1 },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(() => Promise.resolve([])),
    listItems: vi.fn(() => Promise.resolve([])),
    getItem: vi.fn(() => Promise.resolve({})),
    createItem: vi.fn(() => Promise.resolve({})),
    updateItem: vi.fn(() => Promise.resolve({})),
    deleteItem: vi.fn(() => Promise.resolve({})),
    deleteProject: vi.fn(() => Promise.resolve({})),
    createProject: vi.fn(() => Promise.resolve({})),
    bulkUpdateItems: vi.fn(() => Promise.resolve({})),
    trashArchivedItems: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(() => Promise.resolve(FLOW)),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
  },
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>{children}</ThemeProvider>
  </QueryClientProvider>
);

const PROJECT = { id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() };
const baseItem = {
  id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'Fix the picker dismiss',
  status: Status.TODO, createdAt: new Date(), updatedAt: new Date(),
};

const renderBoard = async (item: Record<string, unknown>) => {
  vi.mocked(api.listProjects).mockResolvedValue([PROJECT] as any);
  vi.mocked(api.listItems).mockResolvedValue([item] as any);
  vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as any);
  localStorage.setItem('agenfk_project_id', 'p1');
  render(<KanbanBoard />, { wrapper });
  await waitFor(() => expect(screen.getByText('Fix the picker dismiss')).toBeDefined());
};

describe('JIRA reference badge on the board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient.clear();
    vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as any);
  });
  afterEach(() => cleanup());

  it('shows the key when the card has a reference but NO browse URL', async () => {
    await renderBoard({ ...baseItem, externalId: 'CGLAB-163' });
    expect(screen.getByText('CGLAB-163')).toBeDefined();
  });

  it('does not render it as a link, because there is nowhere to go', async () => {
    await renderBoard({ ...baseItem, externalId: 'CGLAB-163' });
    const badge = screen.getByText('CGLAB-163');
    expect(badge.closest('a')).toBeNull();
  });

  it('still renders the clickable badge when a URL IS present', async () => {
    await renderBoard({
      ...baseItem,
      externalId: 'CGLAB-163',
      externalUrl: 'https://cg-lab.atlassian.net/browse/CGLAB-163',
    });
    const link = document.querySelector('a[href="https://cg-lab.atlassian.net/browse/CGLAB-163"]');
    expect(link).not.toBeNull();
  });

  it('renders no reference badge at all when the card has none', async () => {
    await renderBoard({ ...baseItem });
    expect(screen.queryByText('CGLAB-163')).toBeNull();
  });

  it('treats a null externalId as no reference, not as an empty badge', async () => {
    // The API clears a link by writing null rather than dropping the field.
    await renderBoard({ ...baseItem, externalId: null, externalUrl: null });
    expect(screen.queryByText('CGLAB-163')).toBeNull();
  });
});
