/**
 * @vitest-environment jsdom
 *
 * CGLAB-168's headline contract: one codebase, two shells.
 *
 * The desktop app gets the sidebar, tabs and status bar; a browser gets the
 * board exactly as it always was. Both directions were asserted nowhere — the
 * shell's own suite renders `AppShell` directly and never `App`, so nothing
 * stopped the fork from being wired backwards, or the browser from quietly
 * growing desktop chrome.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import App from '../App';

vi.mock('../components/KanbanBoard', () => ({
  KanbanBoard: () => <div>THE BOARD</div>,
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => ({ version: '1.1.18' })),
  },
}));

const asDesktop = (on: boolean): void => {
  if (on) {
    Object.defineProperty(window, 'agenfkDesktop', {
      value: { isDesktop: true, platform: 'darwin', versions: { electron: '40', chrome: '1', node: '24' } },
      configurable: true, writable: true,
    });
  } else {
    delete (window as unknown as Record<string, unknown>).agenfkDesktop;
  }
};

const renderApp = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
};

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); asDesktop(false); });

describe('App — in a browser', () => {
  it('renders the board', () => {
    renderApp();
    expect(screen.getByText('THE BOARD')).toBeDefined();
  });

  it('adds no desktop chrome: no tabs, no sidebar, no status bar', () => {
    const { container } = renderApp();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.queryByTestId('connection-state')).toBeNull();
  });

  it('declares no drag region, which would be meaningless in a tab', () => {
    const { container } = renderApp();
    expect(container.querySelector('[data-app-region="drag"]')).toBeNull();
  });
});

describe('App — in the desktop app', () => {
  it('wraps the board in the shell', () => {
    // Asserted through the sidebar's WORK nav rather than through a tablist.
    // The shell used to be recognisable by its tab strip; the strip is gone -
    // Kanban, Terminal and Runs all moved to the sidebar - so the nav is the
    // chrome that says the board is wrapped rather than standing alone.
    asDesktop(true);
    renderApp();
    expect(screen.getByText('THE BOARD')).toBeDefined();
    expect(screen.getByRole('navigation', { name: /work/i })).toBeDefined();
  });

  it('shows the sidebar and the status bar', () => {
    asDesktop(true);
    const { container } = renderApp();
    expect(container.querySelector('aside')).not.toBeNull();
    expect(screen.getByTestId('connection-state')).toBeDefined();
  });

  it('mounts the board exactly once, not one per shell branch', () => {
    asDesktop(true);
    renderApp();
    expect(screen.getAllByText('THE BOARD')).toHaveLength(1);
  });
});
