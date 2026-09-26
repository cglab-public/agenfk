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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorktreePanel } from '../components/WorktreePanel';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getGitStatus: vi.fn(), getFileDiff: vi.fn() } }));

// Call history does not reset on its own, and one test here asserts that the
// api was NOT called — which passes or fails on whatever ran before it.
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

/*
 * The view is CHOSEN INSIDE the panel now, not handed to it. The bar carries
 * one button that opens this; the two lists are two halves of one question
 * about one worktree, so making a reader close one to see the other was the
 * wrong split. Tests that want the staged half click the tab, which is what a
 * person does.
 */
const renderPanel = (itemId: string | null = 'i1', view: 'changed' | 'staged' = 'changed') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <WorktreePanel itemId={itemId} />
    </QueryClientProvider>,
  );
  if (view === 'staged') fireEvent.click(screen.getByRole('tab', { name: /staged/i }));
  return result;
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

  it('carries the two lists as tabs, with both counts in view', async () => {
    /*
     * This assertion used to be the opposite - that the panel had no header at
     * all - from the version where the bar carried two buttons and each opened
     * the panel on one list. Reversed deliberately, not dropped: the two are
     * halves of one question about one worktree, and making a reader close one
     * to see the other was the wrong split.
     *
     * The counts belong here BECAUSE they are also in the bar. The bar's
     * button says the worktree has changes while the panel is shut; these say
     * how the changes divide once it is open, which is a different question.
     */
    mixed();
    renderPanel();
    await screen.findByText('a.ts');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.textContent)).toEqual(['Changed (2)', 'Staged (1)']);
    // Exactly one showing: a tablist with none selected describes nothing.
    expect(tabs.filter(t => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
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

/**
 * Opening the diff (be411ffb).
 *
 * The panel could say a file changed and never WHAT changed, so answering
 * "what did this agent just do" meant leaving the app to run git by hand.
 */
describe('opening the diff of a file', () => {
  it('opens the diff of the file the row names', async () => {
    vi.mocked(api.getGitStatus).mockResolvedValue({
      changed: 1, staged: 0,
      files: [{ path: 'src/a.ts', staged: false, state: 'modified' }],
    } as never);
    vi.mocked(api.getFileDiff).mockResolvedValue({
      path: 'src/a.ts', staged: false, diff: '@@ -1 +1 @@\n-old line\n+new line',
    } as never);

    renderPanel();
    // The row is a BUTTON now - a filename list you cannot open stops one
    // question short of the one being asked.
    fireEvent.click(await screen.findByRole('button', { name: /src\/a\.ts/i }));

    expect(await screen.findByTestId('file-diff-modal')).toBeInTheDocument();
    expect(api.getFileDiff).toHaveBeenCalledWith('i1', 'src/a.ts', false);
    expect(await screen.findByText('+new line')).toBeInTheDocument();
  });
});
