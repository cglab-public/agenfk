/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { TerminalTab } from '../components/TerminalTab';

beforeEach(() => {
  // No desktop bridge: the panes render their "desktop only" notice instead of
  // booting xterm, which is irrelevant to what this file asserts and keeps the
  // tests from depending on a canvas.
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});
afterEach(cleanup);

const baseProps = () => ({
  sessions: [{
    id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code',
    autoApprove: false, persist: false, openedAt: new Date().toISOString(),
  }],
  activeId: 's1',
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNew: vi.fn(),
});


/**
 * Opening the worktree in an editor (CGLAB-174).
 *
 * The point is that the user never has to find the path: a worktree lives at
 * ~/.agenfk-worktrees/<repo>/<branch>-<hash>, which nobody is going to type.
 *
 * It belongs on the terminal header because that is where the user already is
 * when they want it — they are looking at the agent's output and want to see
 * the files it just changed.
 */
describe('opening the worktree in an editor', () => {
  it('offers the editors that are installed', async () => {
    render(<TerminalTab {...baseProps()} editors={[{ id: 'vscode', label: 'VS Code' }]} />);
    expect(await screen.findByRole('button', { name: /open in vs code/i })).toBeInTheDocument();
  });

  it('asks for the CARD and the editor, never a path', async () => {
    // The renderer must not be able to name a directory: the path comes from
    // the server's record of which worktree the card owns.
    const onOpenInEditor = vi.fn();
    render(
      <TerminalTab
        {...baseProps()}
        editors={[{ id: 'vscode', label: 'VS Code' }]}
        onOpenInEditor={onOpenInEditor}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open in vs code/i }));
    expect(onOpenInEditor).toHaveBeenCalledWith('i1', 'vscode');
  });

  it('offers nothing when no editor is installed', async () => {
    // A button that opens nothing and explains nothing is worse than no
    // button. The path is still reachable — it is on screen in the header.
    render(<TerminalTab {...baseProps()} editors={[]} />);
    await screen.findByRole('tablist', { name: /open terminals/i });
    expect(screen.queryByRole('button', { name: /open in/i })).toBeNull();
  });
});
