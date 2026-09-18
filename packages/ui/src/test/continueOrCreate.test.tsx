/**
 * Create, or Continue (96953f6a / CGLAB-266).
 *
 * The dialog that opens a terminal has always said "Create", because opening
 * one was always making one. It is not, once herdr is in the picture: a card
 * whose work is already running in a pane does not need a second terminal, and
 * offering to make one is how a person ends up with two agents in the same
 * worktree without meaning to.
 *
 * The word is the whole feature. Everything else about the dialog is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { NewTerminalDialog } from '../components/NewTerminalDialog';

afterEach(cleanup);

const listAgents = async (): Promise<{ id: string; label: string; installed: boolean }[]> => ([
  { id: 'claude-code', label: 'Claude Code', installed: true },
]);

function mount(over: Record<string, unknown> = {}): { onCreate: ReturnType<typeof vi.fn> } {
  const onCreate = vi.fn(async () => {});
  render(
    <NewTerminalDialog
      cardTitle="Adapter herdr"
      onCreate={onCreate}
      onClose={() => {}}
      listAgents={listAgents}
      {...over}
    />,
  );
  return { onCreate };
}

describe('when the card has nothing running', () => {
  it('offers to CREATE, which is what it is doing', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /^create$/i })).toBeTruthy();
  });
});

describe('when something is already running for this card', () => {
  it('offers to CONTINUE instead', async () => {
    /*
     * A card with a live pane does not need a second terminal. The button
     * saying "Create" there is an invitation to end up with two agents in one
     * worktree - which this repository has a whole claims mechanism to survive.
     */
    mount({ existing: { agentId: 'claude-code', where: 'herdr' } });
    expect(await screen.findByRole('button', { name: /^continue$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
  });

  it('says WHERE that session already is, so the word is not a mystery', async () => {
    mount({ existing: { agentId: 'claude-code', where: 'herdr' } });
    expect(await screen.findByTestId('existing-session')).toBeTruthy();
    expect(screen.getByTestId('existing-session').textContent).toMatch(/herdr/i);
  });

  it('names our own terminal when that is where it is', async () => {
    mount({ existing: { agentId: 'claude-code', where: 'agenfk' } });
    const note = await screen.findByTestId('existing-session');
    expect(note.textContent).toMatch(/terminal|AgEnFK/i);
    expect(note.textContent).not.toMatch(/herdr/i);
  });

  it('still hands the caller the agent it was asked about', async () => {
    // Continue is a different WORD, not a different payload: the caller decides
    // what continuing means, and it still needs to know which agent.
    const { onCreate } = mount({ existing: { agentId: 'pi', where: 'herdr' }, defaultAgentId: 'pi' });
    (await screen.findByRole('button', { name: /^continue$/i })).click();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'pi' })));
  });
});

describe('what does not change', () => {
  it('keeps the keyboard shortcut out of the accessible name, either way', async () => {
    mount({ existing: { agentId: 'claude-code', where: 'herdr' } });
    const btn = await screen.findByRole('button', { name: /^continue$/i });
    expect(btn.getAttribute('aria-label')).toBeNull();
    expect(btn.textContent).toMatch(/⌘/);
  });

  it('still says Opening… while it works, whichever word it started with', async () => {
    const slow = new Promise<void>(() => {});
    mount({ existing: { agentId: 'claude-code', where: 'herdr' }, onCreate: () => slow });
    (await screen.findByRole('button', { name: /^continue$/i })).click();
    expect(await screen.findByRole('button', { name: /opening/i })).toBeTruthy();
  });
});
