import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { cardClass } from './Card';

export interface ConfirmOptions {
  /** The question, naming the thing acted on: "Revoke the key laptop-a?" */
  title: string;
  /** What will happen, in plain words. Read out as the dialog's description. */
  body: ReactNode;
  /** The action, as a verb: "Revoke key". Never "OK" or "Yes". */
  confirmLabel: string;
  /** danger (the default) starts focus on Cancel, so Enter does no harm. */
  tone?: 'danger' | 'default';
}

export interface ConfirmDialogProps extends ConfirmOptions {
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirmed request is running: the dialog stays, confirm is disabled. */
  pending?: boolean;
  /** Why the confirmed request failed, shown inside the dialog. */
  error?: string | null;
}

/**
 * The one confirmation for destructive and fleet-wide admin actions. Modal,
 * labelled by its title and described by its consequence; Escape and a click
 * on the backdrop cancel; Tab stays inside; focus returns to whatever opened
 * it. Replaces window.confirm, which cannot be styled, blocks the page and
 * reads a consequence as one run-on line.
 */
export function ConfirmDialog({ title, body, confirmLabel, tone = 'danger', onConfirm, onCancel, pending = false, error = null }: ConfirmDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (tone === 'danger' ? cancelRef : confirmRef).current?.focus();
    return () => { opener?.focus?.(); };
    // Focus moves once, when the dialog opens; a tone change mid-dialog must not steal it.
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); return; }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // Portalled to <body>: rendered inside a `space-y-*` container, the fixed
  // backdrop picked up that container's margin and stopped short of the
  // viewport, leaving a strip of page that was neither dimmed nor blocked.
  return createPortal(
    <div
      data-testid="confirm-dialog-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-deep/60 p-4"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        // Focusable itself, so a click on its text keeps focus (and Escape and
        // the Tab trap) inside instead of dropping it to <body>.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`${cardClass} max-w-md w-full`}
      >
        <h3 id={`${id}-title`} className="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
          {tone === 'danger' && <AlertTriangle className="w-4 h-4 shrink-0 text-status-warn-text" aria-hidden="true" />}
          {title}
        </h3>
        <div id={`${id}-body`} className="mt-2 text-xs text-ink-secondary space-y-2 whitespace-pre-line">{body}</div>
        {error && <p role="alert" className="mt-2 text-xs text-status-danger-text">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button
            ref={confirmRef}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            // The second click of a double-click (detail 2) is not a decision:
            // one dialog can open straight after another, with its confirm
            // button under the pointer.
            onClick={e => { if (e.detail > 1) return; onConfirm(); }}
            disabled={pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * window.confirm, as a promise, in the ConfirmDialog. Render `dialog`
 * somewhere in the component; `await confirm({...})` resolves true when the
 * admin confirms and false when they cancel.
 *
 *   const { confirm, dialog } = useConfirm();
 *   if (!(await confirm({ title, body, confirmLabel }))) return;
 */
export function useConfirm() {
  const [open, setOpen] = useState<(ConfirmOptions & { id: number }) | null>(null);
  const seq = useRef(0);
  // The caller awaiting the dialog on screen. Every promise is settled exactly
  // once: a dialog replaced by a newer one, or left open when the component
  // goes away, answers false rather than leaving its caller waiting forever.
  const waiting = useRef<((ok: boolean) => void) | null>(null);
  const settle = (ok: boolean) => { const resolve = waiting.current; waiting.current = null; resolve?.(ok); };

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>(resolve => {
    settle(false);
    waiting.current = resolve;
    setOpen({ ...opts, id: ++seq.current });
  }), []);
  useEffect(() => () => settle(false), []);

  const answer = (ok: boolean) => { setOpen(null); settle(ok); };
  // Keyed per request: a dialog opened straight after another is a new
  // element, so it mounts again and moves focus again (to Cancel when danger).
  const dialog = open
    ? <ConfirmDialog key={open.id} title={open.title} body={open.body} confirmLabel={open.confirmLabel} tone={open.tone} onConfirm={() => answer(true)} onCancel={() => answer(false)} />
    : null;
  return { confirm, dialog };
}
