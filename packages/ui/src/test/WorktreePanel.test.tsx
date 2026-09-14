/**
 * @vitest-environment jsdom
 *
 * The state of the worktree the visible session is working in (CGLAB-173).
 *
 * What it is for: you are watching an agent edit files and you want to know
 * WHICH files, without leaving the terminal to run git yourself. So the
 * question it answers is "what has this agent touched", and the answer has to
 * be trustworthy — a panel that shows a clean tree when the tree is not clean
 * is worse than no panel, because it is the one thing you would have checked.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorktreePanel } from '../components/WorktreePanel';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getGitStatus: vi.fn(), listWorktreeFiles: vi.fn() } }));

// Call history does not reset on its own, and one test here asserts that the
// api was NOT called — which passes or fails on whatever ran before it.
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

const renderPanel = (itemId: string | null = 'i1') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorktreePanel itemId={itemId} />
    </QueryClientProvider>,
  );
};

describe('what it shows', () => {
  it('counts what is changed and what is staged', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 2, staged: 1,
      files: [
        { path: 'a.ts', staged: false, state: 'modified' },
        { path: 'b.ts', staged: false, state: 'untracked' },
        { path: 'c.ts', staged: true, state: 'added' },
      ],
    } as never);
    renderPanel();
    expect(await screen.findByText(/changed \(2\)/i)).toBeInTheDocument();
    expect(await screen.findByText(/staged \(1\)/i)).toBeInTheDocument();
  });

  it('lists the files, so the counts can be checked against something', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 1, staged: 0,
      files: [{ path: 'src/deep/file.ts', staged: false, state: 'modified' }],
    } as never);
    renderPanel();
    expect(await screen.findByText('src/deep/file.ts')).toBeInTheDocument();
  });

  it('says a rename came from somewhere, which is the whole point of a rename', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 0, staged: 1,
      files: [{ path: 'new.ts', staged: true, state: 'renamed', from: 'old.ts' }],
    } as never);
    renderPanel();
    expect(await screen.findByText(/old\.ts/)).toBeInTheDocument();
  });
});

describe('what it refuses to imply', () => {
  it('does not show a clean tree while it is still asking', async () => {
    // "Nothing changed" is a claim. Showing it before the answer arrives makes
    // the panel assert something it has not checked — and this is the one
    // thing the user opened it to check.
    vi.mocked(api.getGitStatus).mockImplementation(() => new Promise(() => {}) as never);
    renderPanel();
    expect(screen.queryByText(/no changes/i)).toBeNull();
  });

  it('says it could not read the worktree, rather than showing it as clean', async () => {
    vi.mocked(api.getGitStatus).mockRejectedValue(new Error('not a repository'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not|worktree/i);
  });

  it('shows a clean tree only when it really is one', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    renderPanel();
    expect(await screen.findByText(/no changes/i)).toBeInTheDocument();
  });

  it('asks nothing when there is no session to ask about', async () => {
    renderPanel(null);
    await new Promise(r => setTimeout(r, 20));
    expect(api.getGitStatus).not.toHaveBeenCalled();
  });
});

/**
 * Browsing the worktree's files (CGLAB-175).
 *
 * The same panel, a second view: what the agent CHANGED and what is actually
 * in there are different questions, and the second one is how you find the
 * file you want to open.
 */
describe('the file tree', () => {
  const listing = (entries: Array<{ name: string; kind: string }>) =>
    vi.mocked(api.listWorktreeFiles).mockResolvedValue({ path: '', entries } as never);

  it('shows what is in the worktree', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    listing([{ name: 'src', kind: 'directory' }, { name: 'README.md', kind: 'file' }]);
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /files/i }));
    expect(await screen.findByText('README.md')).toBeInTheDocument();
  });

  it('renders the order it was given, because ordering is decided once', async () => {
    // Directories-first is the SERVER's job and is asserted there. Sorting
    // again here would be a second opinion about the same question, and the
    // two would drift.
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    listing([{ name: 'zz-dir', kind: 'directory' }, { name: 'a.ts', kind: 'file' }]);
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /files/i }));
    await screen.findByText('a.ts');
    const rows = [...document.querySelectorAll('[data-testid="file-entry"]')].map(n => n.textContent);
    expect(rows[0]).toContain('zz-dir');
  });

  it('descends into a directory by NAME, never by a path it was handed', async () => {
    // The renderer composes a path only from names the server gave it, and the
    // server anchors every read to the worktree by resolved path. A panel that
    // let the user type a path would be the filesystem browser the endpoint
    // exists to not be.
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    listing([{ name: 'src', kind: 'directory' }]);
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /files/i }));
    fireEvent.click(await screen.findByText('src'));
    await waitFor(() =>
      expect(api.listWorktreeFiles).toHaveBeenCalledWith('i1', 'src'));
  });

  it('says when it could not read the tree, rather than showing it empty', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({ changed: 0, staged: 0, files: [] } as never);
    vi.mocked(api.listWorktreeFiles).mockRejectedValue(new Error('no worktree'));
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /files/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
