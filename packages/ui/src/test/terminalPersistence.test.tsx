/**
 * @vitest-environment jsdom
 *
 * Telling the user whether this terminal survives quitting the app.
 *
 * There are two different persistences, and conflating them is how a user
 * loses an hour of work:
 *
 *  - **The conversation** always survives. It lives in the agent's own
 *    transcript, and reopening the card resumes it. Nothing here is needed for
 *    that.
 *  - **The process** survives only inside tmux. Without it, quitting kills the
 *    agent mid-run and the scrollback goes with it.
 *
 * So this is not a settings checkbox, it is a warning with a switch attached.
 * Three rules follow, and they are what this file guards.
 *
 * **Off by default.** Running the agent inside tmux changes the terminal it
 * lives in: the tmux prefix starts competing with the agent's own shortcuts and
 * nothing says so. Also, every session that predates the feature worked without
 * it — an upgrade must not silently change how someone's terminal behaves.
 *
 * **Never offered where it cannot work.** A switch that reads "on" while the
 * main process quietly ignores it is worse than no switch: the user believes
 * the agent is protected and finds out otherwise by losing it.
 *
 * **The reason is visible, not just the state.** "Not available" sends the user
 * hunting. `brew install tmux` does not.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { NewTerminalDialog, type NewTerminalRequest } from '../components/NewTerminalDialog';

afterEach(cleanup);

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
];

const renderDialog = (
  persistence: { available: boolean; hint?: string; warning?: string },
  onCreate = vi.fn(async (_req: NewTerminalRequest) => {}),
) => {
  render(
    <NewTerminalDialog
      cardTitle="Work"
      onCreate={onCreate}
      onClose={vi.fn()}
      listAgents={async () => AGENTS}
      sessionPersistence={async () => persistence}
    />,
  );
  return onCreate;
};

describe('when tmux is available', () => {
  it('offers the choice, switched off', async () => {
    // The default the user gets without deciding anything. It has to be the
    // one that changes nothing about how their terminal already behaves.
    renderDialog({ available: true });
    const toggle = await screen.findByRole('switch', { name: /keep running|survive/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).not.toBeDisabled();
  });

  it('asks for persistence only after the user turns it on', async () => {
    const onCreate = renderDialog({ available: true });
    fireEvent.click(await screen.findByRole('switch', { name: /keep running|survive/i }));
    fireEvent.click(screen.getByRole('button', { name: /^create|open terminal/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({ persist: true });
  });

  it('does not ask for persistence when left alone', async () => {
    const onCreate = renderDialog({ available: true });
    await screen.findByRole('switch', { name: /keep running|survive/i });
    fireEvent.click(screen.getByRole('button', { name: /^create|open terminal/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({ persist: false });
  });
});

describe('when tmux is missing', () => {
  it('says so, and says how to fix it', async () => {
    // The hint is the whole point. "Unavailable" with no remedy is a dead end.
    renderDialog({ available: false, hint: 'brew install tmux' });
    expect(await screen.findByText(/brew install tmux/)).toBeInTheDocument();
  });

  it('cannot be switched on', async () => {
    renderDialog({ available: false, hint: 'brew install tmux' });
    const toggle = await screen.findByRole('switch', { name: /keep running|survive/i });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('never sends persist, even if the switch is clicked at', async () => {
    // Belt and braces. `disabled` is a DOM affordance; what reaches the main
    // process is what actually decides whether the agent is protected.
    const onCreate = renderDialog({ available: false, hint: 'brew install tmux' });
    fireEvent.click(await screen.findByRole('switch', { name: /keep running|survive/i }));
    fireEvent.click(screen.getByRole('button', { name: /^create|open terminal/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({ persist: false });
  });

  it('explains what is actually lost, not just that a feature is off', async () => {
    // A user who reads "tmux unavailable" learns nothing. A user who reads that
    // quitting kills the agent knows not to quit mid-run.
    renderDialog({ available: false, hint: 'brew install tmux' });
    expect(await screen.findByTestId('persistence-note')).toHaveTextContent(/quit/i);
  });
});

describe('on Windows, where tmux cannot exist at all', () => {
  it('states the platform reason rather than offering an install command', async () => {
    renderDialog({ available: false, warning: 'tmux_unsupported_on_windows' });
    const note = await screen.findByTestId('persistence-note');
    expect(note).toHaveTextContent(/windows/i);
    expect(note).not.toHaveTextContent(/brew|apt/i);
  });
});

describe('while the answer is still unknown', () => {
  it('does not claim persistence works before it has been checked', async () => {
    // The check is an IPC round trip. Rendering an enabled switch first and
    // correcting it afterwards is a promise the app may not keep.
    let release!: (v: { available: boolean }) => void;
    render(
      <NewTerminalDialog
        cardTitle="Work"
        onCreate={vi.fn(async () => {})}
        onClose={vi.fn()}
        listAgents={async () => AGENTS}
        sessionPersistence={() => new Promise(res => { release = res; })}
      />,
    );
    const toggle = await screen.findByRole('switch', { name: /keep running|survive/i });
    expect(toggle).toBeDisabled();
    release({ available: true });
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });

  it('degrades to "no persistence" when the check fails outright', async () => {
    // A rejected probe must read as "not protected". Treating an error as
    // available would be the one failure mode that costs the user work.
    renderDialog({ available: true });
    cleanup();
    const onCreate = vi.fn(async (_req: NewTerminalRequest) => {});
    render(
      <NewTerminalDialog
        cardTitle="Work"
        onCreate={onCreate}
        onClose={vi.fn()}
        listAgents={async () => AGENTS}
        sessionPersistence={async () => { throw new Error('ipc down'); }}
      />,
    );
    const toggle = await screen.findByRole('switch', { name: /keep running|survive/i });
    await waitFor(() => expect(toggle).toBeDisabled());
  });
});

describe('reaching the host', () => {
  it('reads "no persistence" from a preload too old to answer', async () => {
    // The renderer bundle and the preload ship as separate artifacts and can be
    // mismatched after an upgrade: the older one exposes `terminal` without
    // this method. Calling it blind threw a TypeError that took the entire
    // dialog with it, so the user could not open a terminal AT ALL because of a
    // feature that only draws a warning label.
    const { sessionPersistenceFromBridge } = await import('../components/agentBridge');
    (window as unknown as Record<string, unknown>).agenfkDesktop = {
      terminal: { listAgents: async () => [] },
    };
    await expect(sessionPersistenceFromBridge()).resolves.toEqual({ available: false });
    delete (window as unknown as Record<string, unknown>).agenfkDesktop;
  });

  it('reads "no persistence" in a browser, where there is no host at all', async () => {
    const { sessionPersistenceFromBridge } = await import('../components/agentBridge');
    await expect(sessionPersistenceFromBridge()).resolves.toEqual({ available: false });
  });
});

/**
 * The stored preference, and why the dialog reads it at all.
 *
 * Without this the server field is dead weight: something writes it, nothing
 * reads it, and the code looks finished. That is the exact failure this epic
 * has now hit three times (`supportsAutoApprove`, `sessions:persistence`), so
 * the read side gets a test of its own rather than being assumed.
 *
 * The capability is applied HERE, on read, not at write time. A project whose
 * preference is on, opened on a machine without tmux, must show the switch off
 * and still have the preference intact when it goes back to a machine that has
 * it — otherwise visiting from Windows silently erases a choice.
 */
describe('the project preference', () => {
  it('starts the switch on when the project asked for it', async () => {
    render(
      <NewTerminalDialog
        cardTitle="Work"
        onCreate={vi.fn(async () => {})}
        onClose={vi.fn()}
        listAgents={async () => AGENTS}
        sessionPersistence={async () => ({ available: true })}
        defaultPersist
      />,
    );
    const toggle = await screen.findByRole('switch', { name: /keep running|survive/i });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows it off where tmux cannot run, without forgetting it', async () => {
    // The preference is untouched; only the display reflects this machine. The
    // dialog has no business writing a "no" the user never said.
    const onCreate = vi.fn(async (_req: NewTerminalRequest) => {});
    render(
      <NewTerminalDialog
        cardTitle="Work"
        onCreate={onCreate}
        onClose={vi.fn()}
        listAgents={async () => AGENTS}
        sessionPersistence={async () => ({ available: false, hint: 'brew install tmux' })}
        defaultPersist
      />,
    );
    const toggle = await screen.findByRole('switch', { name: /keep running|survive/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^create|open terminal/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({ persist: false });
  });

  it('reports a change so the caller can store it', async () => {
    // Reported, not written from in here. The dialog does not know what a
    // project is, and giving it a server client would make it untestable for
    // the sake of one boolean.
    const onPersistChange = vi.fn();
    render(
      <NewTerminalDialog
        cardTitle="Work"
        onCreate={vi.fn(async () => {})}
        onClose={vi.fn()}
        listAgents={async () => AGENTS}
        sessionPersistence={async () => ({ available: true })}
        onPersistChange={onPersistChange}
      />,
    );
    fireEvent.click(await screen.findByRole('switch', { name: /keep running|survive/i }));
    expect(onPersistChange).toHaveBeenCalledWith(true);
  });

  it('reports nothing when the switch cannot be moved', async () => {
    const onPersistChange = vi.fn();
    render(
      <NewTerminalDialog
        cardTitle="Work"
        onCreate={vi.fn(async () => {})}
        onClose={vi.fn()}
        listAgents={async () => AGENTS}
        sessionPersistence={async () => ({ available: false })}
        onPersistChange={onPersistChange}
      />,
    );
    fireEvent.click(await screen.findByRole('switch', { name: /keep running|survive/i }));
    await waitFor(() => expect(screen.getByRole('switch', { name: /keep running/i })).toBeDisabled());
    expect(onPersistChange).not.toHaveBeenCalled();
  });
});
