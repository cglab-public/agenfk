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
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorktreePanel } from '../components/WorktreePanel';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getGitStatus: vi.fn() } }));

// Call history does not reset on its own, and one test here asserts that the
// api was NOT called — which passes or fails on whatever ran before it.
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

const renderPanel = (itemId: string | null = 'i1', view: 'changed' | 'staged' = 'changed') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorktreePanel itemId={itemId} view={view} />
    </QueryClientProvider>,
  );
};

describe('what it shows', () => {
  const mixed = () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 2, staged: 1,
      files: [
        { path: 'a.ts', staged: false, state: 'modified' },
        { path: 'b.ts', staged: false, state: 'untracked' },
        { path: 'c.ts', staged: true, state: 'added' },
      ],
    } as never);
  };

  it('carries no header of its own any more', async () => {
    /*
     * `CHANGED (n)` and `STAGED (n)` used to be two static labels at the top of
     * this panel. They are buttons in the terminal's top bar now, and the row
     * has to be GONE rather than restyled in place: the terminal only gains
     * the space if nothing is left occupying it.
     */
    mixed();
    renderPanel();
    await screen.findByText('a.ts');
    expect(screen.queryByText(/changed \(\d+\)/i)).toBeNull();
    expect(screen.queryByText(/staged \(\d+\)/i)).toBeNull();
  });

  it('shows one list at a time, named by the button that opened it', async () => {
    // The split the two buttons imply. A panel that showed both lists whichever
    // button was pressed would make the pair decoration.
    mixed();
    renderPanel('i1', 'changed');
    expect(await screen.findByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(screen.queryByText('c.ts')).toBeNull();
  });

  it('shows the staged files, and only those, on the staged view', async () => {
    mixed();
    renderPanel('i1', 'staged');
    expect(await screen.findByText('c.ts')).toBeInTheDocument();
    expect(screen.queryByText('a.ts')).toBeNull();
  });

  it('says which list is empty, rather than one sentence for both', async () => {
    // "No changes in this worktree" under the Staged button would be answering
    // a question the user did not ask.
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 1, staged: 0,
      files: [{ path: 'a.ts', staged: false, state: 'modified' }],
    } as never);
    renderPanel('i1', 'staged');
    expect(await screen.findByText(/nothing staged/i)).toBeInTheDocument();
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
    renderPanel('i1', 'staged');
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
/*
 * The "file tree" describe that stood here is gone with the Files tab it
 * covered. Removed rather than left skipped: a test for a feature that no
 * longer exists is a claim about behaviour nobody can observe, and it is the
 * kind of thing that gets "fixed" back into life by whoever trips over it.
 *
 * What the tab was for — "which files has this agent touched" — is what the
 * changed list above answers, and those tests stay.
 */
