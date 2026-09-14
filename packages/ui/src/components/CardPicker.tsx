/**
 * Choosing which card a new terminal opens on (CGLAB-184).
 *
 * The `+` in the terminal strip used to reopen on the ACTIVE session's card and
 * nothing else, so there was no way from the Terminal view to any other card —
 * you had to go back to the sidebar. With one or two tabs that is a shrug; with
 * ten it is the wrong shape.
 *
 * Worse, with no active session the `+` did nothing at all: no dialog, no
 * message, no disabled state. A control that does not respond reads as a broken
 * app rather than as a control with nothing to act on.
 *
 * This sits BEFORE the agent dialog rather than inside it. That dialog's whole
 * identity is "open a terminal on THIS card" — it is named after the card in
 * its own aria-label — and three other callers already arrive at it having
 * decided which card they mean. Folding a card selector in would have made
 * every one of them carry a choice they had already made.
 */
import React from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { AgEnFKItem } from '../types';

export interface CardPickerProps {
  /** The cards on offer — work in flight, the same list the sidebar shows. */
  readonly items: readonly AgEnFKItem[];
  /** The card the strip is currently on, listed first and marked. */
  readonly currentItemId?: string;
  readonly onPick: (item: AgEnFKItem) => void;
  readonly onClose: () => void;
}

/**
 * The current card first, then the rest in the order they arrived.
 *
 * Not sorted by title or by step: the overwhelmingly common reason to press `+`
 * is a second agent on the card you are already looking at, and making that the
 * first row costs the other cases nothing.
 */
export function orderForPicker(
  items: readonly AgEnFKItem[],
  currentItemId?: string,
): AgEnFKItem[] {
  const current = items.filter(i => i.id === currentItemId);
  return [...current, ...items.filter(i => i.id !== currentItemId)];
}

export function CardPicker({ items, currentItemId, onPick, onClose }: CardPickerProps) {
  const ordered = React.useMemo(() => orderForPicker(items, currentItemId), [items, currentItemId]);

  return (
    <div className="fixed inset-0 z-50 flex animate-[fadeIn_120ms_ease-out] items-center justify-center bg-black/50 p-4 motion-reduce:animate-none">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open a terminal on which card"
        // Escape closes, because a picker you cannot dismiss from the keyboard
        // is a trap for anyone not using a pointer — which is the same audience
        // the `+` doing nothing already failed.
        onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
        className="flex max-h-[70vh] w-full max-w-md animate-[popIn_140ms_cubic-bezier(0.2,0,0,1)] flex-col rounded-2xl border border-border-soft bg-nav-surface shadow-2xl motion-reduce:animate-none"
      >
        <div className="flex items-start gap-3 border-b border-border-soft px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-tertiary">
              New terminal
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">Which card?</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {ordered.length === 0 ? (
            /*
             * A sentence, not an empty box. This is the state the `+` used to
             * answer with silence, and "nothing is in flight" is a real answer
             * that tells the user what to do next; a blank panel is not.
             */
            <p className="px-3 py-6 text-center text-xs text-ink-tertiary">
              No work in flight. Start a card on the board, then open a terminal on it.
            </p>
          ) : (
            <ul>
              {ordered.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onPick(item)}
                    title={item.title}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-canvas',
                      item.id === currentItemId && 'bg-canvas/60',
                    )}
                  >
                    <span className="truncate text-xs text-ink">{item.title}</span>
                    {item.id === currentItemId && (
                      // Said in words, not only by the background tint: a
                      // colour difference is not available to everyone.
                      <span className="shrink-0 text-[9px] uppercase tracking-wide text-ink-tertiary">
                        current
                      </span>
                    )}
                    {/* The step, for the same reason the sidebar shows it: it
                        is what says where the card is sitting. */}
                    <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wide text-ink-tertiary">
                      {item.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
