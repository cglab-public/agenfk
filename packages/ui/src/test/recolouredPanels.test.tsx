/**
 * @vitest-environment jsdom
 *
 * CGLAB-434 S5.2: the panels that had no render test of their own. Each test
 * drives the component into the state that shows the most chrome, and the
 * token guard sweeps what it rendered.
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import { GitHubImportModal } from '../components/GitHubImportModal';
import { DiffModal } from '../components/DiffModal';
import { BoardSettingsDialog } from '../components/BoardSettingsDialog';
import { Switch } from '../components/ui/switch';
import { DOT, STATE_LABEL } from '../components/sessionPresentation';
import { guardTokens } from './helpers/tokenGuard';

vi.mock('../api', () => ({
  api: {
    listGitHubIssues: vi.fn(),
    importGitHubIssues: vi.fn(),
    getFileDiff: vi.fn(),
  },
}));

// The dialog's frame is under test here; SettingsPanel has its own suite.
vi.mock('../components/SettingsPanel', () => ({
  SettingsPanel: () => <div data-testid="settings-panel-stub" />,
}));

const withQuery = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

afterEach(cleanup);
guardTokens();

beforeEach(() => vi.clearAllMocks());

describe('GitHubImportModal on tokens', () => {
  beforeEach(() => {
    vi.mocked(api.listGitHubIssues).mockResolvedValue([
      { number: 7, title: 'Crash on start', state: 'open', labels: ['bug'], url: 'https://example.test/7' },
      { number: 8, title: 'Add export', state: 'open', labels: [], url: 'https://example.test/8' },
    ]);
  });

  it('renders the issue list with a selected issue and its type chip', async () => {
    withQuery(<GitHubImportModal open onClose={() => {}} projectId="p1" />);
    await screen.findByText('Crash on start');
    fireEvent.click(screen.getAllByRole('checkbox').find(c => c.closest('li')?.textContent?.includes('Crash on start'))!);
    expect(await screen.findByText(/Next \(1 selected\)/)).toBeTruthy();
  });

  it('renders the confirm step', async () => {
    withQuery(<GitHubImportModal open onClose={() => {}} projectId="p1" />);
    await screen.findByText('Crash on start');
    fireEvent.click(screen.getAllByRole('checkbox').find(c => c.closest('li')?.textContent?.includes('Crash on start'))!);
    fireEvent.click(await screen.findByText(/Next \(1 selected\)/));
    expect(await screen.findByText('Confirm Import')).toBeTruthy();
  });

  it('renders the error state', async () => {
    vi.mocked(api.listGitHubIssues).mockRejectedValue(new Error('GitHub is not connected'));
    withQuery(<GitHubImportModal open onClose={() => {}} projectId="p1" />);
    expect(await screen.findByText('Failed to load GitHub issues.')).toBeTruthy();
  });
});

describe('DiffModal on tokens', () => {
  it('renders added, removed and hunk lines', async () => {
    vi.mocked(api.getFileDiff).mockResolvedValue({
      path: 'src/a.ts',
      staged: true,
      diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context',
    });
    withQuery(<DiffModal itemId="i1" filePath="src/a.ts" staged onClose={() => {}} />);
    expect(await screen.findByText('+new line')).toBeTruthy();
    expect(screen.getByText('staged')).toBeTruthy();
  });

  it('renders the error state', async () => {
    vi.mocked(api.getFileDiff).mockRejectedValue(new Error('not in a worktree'));
    withQuery(<DiffModal itemId="i1" filePath="src/a.ts" staged={false} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('BoardSettingsDialog on tokens', () => {
  it('renders its frame around the settings panel', () => {
    render(<BoardSettingsDialog onClose={() => {}} />);
    expect(screen.getByTestId('settings-panel-stub')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });
});

describe('Switch on tokens', () => {
  it('wears the indigo accent when on, not the brand teal', () => {
    render(<Switch aria-label="Sound" defaultChecked />);
    const sw = screen.getByRole('switch', { name: 'Sound' });
    expect(sw.getAttribute('data-state')).toBe('checked');
    expect(sw.className).toMatch(/(?:^|\s)data-\[state=checked\]:bg-accent(?:\s|$)/);
    expect(sw.className).not.toMatch(/bg-brand/);
  });

  it('renders off, and turns on when clicked', () => {
    render(<Switch aria-label="Sound" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sound' }));
    expect(screen.getByRole('switch', { name: 'Sound' }).getAttribute('data-state')).toBe('checked');
  });
});

describe('session state dots on tokens', () => {
  it('renders every state', () => {
    render(<ul>{(Object.keys(DOT) as (keyof typeof DOT)[]).map(k => <li key={k}><span className={DOT[k]} />{STATE_LABEL[k]}</li>)}</ul>);
    expect(screen.getAllByRole('listitem')).toHaveLength(Object.keys(DOT).length);
  });
});
