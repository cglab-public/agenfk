/**
 * @vitest-environment jsdom
 *
 * [UX] Admin safety: one shared ConfirmDialog for destructive and fleet-wide
 * actions, replacing window.confirm (unstyled, blocks the page, can't state a
 * consequence well) and the one-off DetachDialog.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useState } from 'react';
import { ConfirmDialog, useConfirm } from '../components/ui';

afterEach(cleanup);

const base = {
  title: 'Revoke this API key?',
  body: 'Machines using it stop reporting at once.',
  confirmLabel: 'Revoke key',
};

describe('ConfirmDialog', () => {
  it('is a labelled modal dialog that states the consequence', () => {
    render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} />);
    const d = screen.getByRole('dialog', { name: 'Revoke this API key?' });
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleDescription('Machines using it stop reporting at once.');
    expect(screen.getByRole('button', { name: 'Revoke key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('starts on Cancel when the action is destructive, so Enter does no harm', () => {
    render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('starts on the confirm button for a routine confirmation', () => {
    render(<ConfirmDialog {...base} tone="default" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Revoke key' })).toHaveFocus();
  });

  it('marks a destructive confirm button with the danger style', () => {
    render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Revoke key' }).className).toMatch(/status-danger/);
  });

  it('cancels on Escape and on a backdrop click, not on a click inside', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('keeps Tab inside the dialog', () => {
    render(<><button>outside</button><ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} /></>);
    const confirm = screen.getByRole('button', { name: 'Revoke key' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // Whichever is last, Tab from it wraps to the first, and Shift+Tab from the first wraps to the last.
    const [first, last] = confirm.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING ? [confirm, cancel] : [cancel, confirm];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('gives focus back to what opened it when it closes', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && <ConfirmDialog {...base} onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)} />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(opener).toHaveFocus();
  });

  it('while pending, the confirm button is disabled and says so', () => {
    render(<ConfirmDialog {...base} pending onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: /revoke key|working/i })).toBeDisabled();
  });

  it('shows an error inside the dialog', () => {
    render(<ConfirmDialog {...base} error="Key already revoked" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Key already revoked');
  });
});

describe('useConfirm', () => {
  function Host({ onAnswer }: { onAnswer: (v: boolean) => void }) {
    const { confirm, dialog } = useConfirm();
    return (
      <>
        <button onClick={async () => onAnswer(await confirm(base))}>Revoke</button>
        {dialog}
      </>
    );
  }

  it('resolves true on confirm and closes', async () => {
    const onAnswer = vi.fn();
    render(<Host onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke key' })); });
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves false on Cancel and on Escape', async () => {
    const onAnswer = vi.fn();
    render(<Host onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); });
    expect(onAnswer.mock.calls).toEqual([[false], [false]]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ConfirmDialog, hardening (review of story 5a67f0be)', () => {
  it('renders into document.body, outside any spacing container that would shorten the backdrop', () => {
    render(<div className="space-y-6"><ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} /></div>);
    expect(screen.getByTestId('confirm-dialog-backdrop').parentElement).toBe(document.body);
  });

  it('can take focus itself, so a click on its text does not lose Escape and the Tab trap', () => {
    render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('tabindex', '-1');
  });

  it('ignores the second click of a double-click, so one dialog cannot confirm the next', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }), { detail: 2 });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('useConfirm, hardening', () => {
  it('a dialog opened straight after another starts again on Cancel', async () => {
    function Host() {
      const { confirm, dialog } = useConfirm();
      return (
        <>
          <button onClick={async () => { if (await confirm(base)) await confirm({ ...base, title: 'Second?', confirmLabel: 'Do it' }); }}>Go</button>
          {dialog}
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke key' })); });
    expect(await screen.findByRole('dialog', { name: 'Second?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('answers false to a dialog that another one replaces', async () => {
    const answers: boolean[] = [];
    let api!: ReturnType<typeof useConfirm>;
    function Host() { api = useConfirm(); return <>{api.dialog}</>; }
    render(<Host />);
    act(() => { void api.confirm(base).then(v => answers.push(v)); });
    act(() => { void api.confirm({ ...base, title: 'Newer?' }); });
    await act(async () => {});
    expect(answers).toEqual([false]);
    expect(screen.getByRole('dialog', { name: 'Newer?' })).toBeInTheDocument();
  });

  it('answers false when its component goes away with the dialog open', async () => {
    const answers: boolean[] = [];
    let api!: ReturnType<typeof useConfirm>;
    function Host() { api = useConfirm(); return <>{api.dialog}</>; }
    const { unmount } = render(<Host />);
    act(() => { void api.confirm(base).then(v => answers.push(v)); });
    unmount();
    await act(async () => {});
    expect(answers).toEqual([false]);
  });
});

