/**
 * @vitest-environment jsdom
 *
 * CGLAB-169: the dialog that opens a terminal on a card.
 *
 * Small surface, three real hazards:
 *
 *  - Re-entrancy. Create is reachable by click and by the keyboard shortcut,
 *    and launching an agent CLI takes a moment. Two presses would spawn two
 *    processes in the same worktree, both editing the same files.
 *  - Auto-approve. The toggle disables the agent's own permission prompts, so
 *    it must default off, must be offered only where the agent can honour it,
 *    and must not survive as a sticky preference the user forgot they set.
 *  - Dismissal. Escape must not tear the dialog down while a spawn is in
 *    flight, or the session is created with nobody holding it.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { NewTerminalDialog } from '../components/NewTerminalDialog';

const AGENTS = [
  { id: 'claude', label: 'Claude Code', installed: true, supportsAutoApprove: true },
  { id: 'codex', label: 'Codex', installed: false, supportsAutoApprove: true },
  { id: 'gemini', label: 'Gemini CLI', installed: true, supportsAutoApprove: false },
  { id: 'shell', label: 'Shell', installed: true, supportsAutoApprove: false },
];

const renderDialog = (props: Partial<React.ComponentProps<typeof NewTerminalDialog>> = {}) => {
  const onCreate = props.onCreate ?? vi.fn(async () => {});
  const onClose = props.onClose ?? vi.fn();
  const view = render(
    <NewTerminalDialog
      cardTitle="Fix the flaky test"
      onCreate={onCreate}
      onClose={onClose}
      listAgents={async () => AGENTS}
      {...props}
    />,
  );
  return { view, onCreate, onClose };
};

const createButton = () => screen.getByRole('button', { name: /^create$/i });

beforeEach(() => {
  // The dialog remembers the chosen agent. Without clearing it, a test that
  // picks Gemini CLI leaves the NEXT test's picker showing Gemini CLI, and every
  // lookup for "Claude Code" fails for a reason that has nothing to do with
  // what is being tested.
  localStorage.clear();
});
afterEach(() => cleanup());

describe('what it opens with', () => {
  it('names the card, so you know which worktree you are about to work in', async () => {
    renderDialog();
    expect(await screen.findByText(/fix the flaky test/i)).toBeDefined();
  });

  it('is a dialog as far as assistive tech is concerned', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label') || dialog.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('starts with auto-approve off', async () => {
    // The safe default, every time. This is not a preference to remember.
    renderDialog();
    const toggle = await screen.findByRole('switch', { name: /skip permissions/i });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});

describe('creating', () => {
  it('passes the chosen agent and the toggle state', async () => {
    const { onCreate } = renderDialog();
    fireEvent.click(await screen.findByRole('switch', { name: /skip permissions/i }));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ agentId: 'claude', autoApprove: true }));
  });

  it('defaults to not skipping permissions when the toggle is untouched', async () => {
    const { onCreate } = renderDialog();
    await screen.findByRole('switch', { name: /skip permissions/i });
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ agentId: 'claude', autoApprove: false }));
  });

  it('creates on the keyboard shortcut', async () => {
    const { onCreate } = renderDialog();
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
  });

  it('does not spawn twice when Create is pressed twice', async () => {
    // Launching an agent takes a moment and Create is reachable two ways. Two
    // processes in one worktree would both be editing the same files.
    let release: () => void = () => {};
    const onCreate = vi.fn(() => new Promise<void>(res => { release = res; }));
    renderDialog({ onCreate });
    await screen.findByRole('switch', { name: /skip permissions/i });

    // Captured once: after the first press the button relabels to "Opening…",
    // so looking it up again by name would miss the very element under test.
    const button = createButton();
    fireEvent.click(button);
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });

    expect(onCreate).toHaveBeenCalledTimes(1);
    release();
  });

  it('says it is working rather than looking unresponsive', async () => {
    const onCreate = vi.fn(() => new Promise<void>(() => {}));
    renderDialog({ onCreate });
    await screen.findByRole('switch', { name: /skip permissions/i });
    fireEvent.click(createButton());
    expect(await screen.findByRole('button', { name: /opening/i })).toBeDefined();
  });

  it('shows the failure instead of closing silently', async () => {
    // A worktree that cannot be created gives a message naming what to fix.
    // Closing on failure would throw that away.
    const onCreate = vi.fn(async () => { throw new Error('project has no project root'); });
    const { onClose } = renderDialog({ onCreate });
    await screen.findByRole('switch', { name: /skip permissions/i });
    fireEvent.click(createButton());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/project root/i));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('recovers after a failure rather than staying stuck', async () => {
    let fail = true;
    const onCreate = vi.fn(async () => { if (fail) throw new Error('nope'); });
    renderDialog({ onCreate });
    await screen.findByRole('switch', { name: /skip permissions/i });

    fireEvent.click(createButton());
    await screen.findByRole('alert');

    fail = false;
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
  });
});

describe('the auto-approve toggle', () => {
  it('is unavailable for an agent that cannot honour it', async () => {
    // Offering a control that quietly does nothing is worse than not offering
    // it: the user believes the agent is running unattended when it is not.
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /gemini/i }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /skip permissions/i }).getAttribute('aria-disabled')).toBe('true'));
  });

  it('says why it is unavailable', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /gemini/i }));
    expect(await screen.findByText(/does not support/i)).toBeDefined();
  });

  it('turns itself off when switching to an agent that cannot honour it', async () => {
    // Otherwise the toggle reads "on" while the flag is silently dropped —
    // the user thinks the rails are off and they are not.
    const { onCreate } = renderDialog();
    fireEvent.click(await screen.findByRole('switch', { name: /skip permissions/i }));
    fireEvent.click(screen.getByRole('button', { name: /claude code/i }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /gemini/i }));
    fireEvent.click(createButton());
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ agentId: 'gemini', autoApprove: false }));
  });
});

describe('dismissing', () => {
  it('closes on Escape', async () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses to close while a spawn is in flight', async () => {
    // The main process would be left holding a session nobody asked to keep.
    const onCreate = vi.fn(() => new Promise<void>(() => {}));
    const { onClose } = renderDialog({ onCreate });
    await screen.findByRole('switch', { name: /skip permissions/i });
    fireEvent.click(createButton());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
