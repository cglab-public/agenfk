/**
 * Choosing which card a new terminal opens on (CGLAB-184).
 *
 * The `+` in the terminal strip used to reopen on the ACTIVE session's card and
 * nothing else, so there was no way from the Terminal view to any other card —
 * you had to go back to the sidebar. With one or two tabs that is a shrug; with
 * ten it is the wrong shape.
 *
 * An earlier version of this file claimed the `+` also did nothing when there
 * was no active session. Review checked and that state is unreachable:
 * `TerminalTab` renders an EmptyState before the strip when there are no
 * sessions, so the `+` does not exist, and with sessions present an active one
 * is always set. The empty-list message below still earns its place — a card
 * can leave the active-work list while its terminal survives — but the
 * justification was invented and is corrected here rather than left standing.
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
  /**
   * Project id to name, for the row's second line.
   *
   * The list is CROSS-PROJECT — `listActiveItems` passes no project filter — and
   * the sidebar only gets away with showing bare titles because it groups by
   * project, which a flat dialog does not. Two cards called "Fix flaky test" in
   * two repos were indistinguishable rows, and picking one re-points the board
   * and reshuffles the sidebar's last-used order. Saying which project it is
   * makes that a choice instead of a surprise.
   */
  readonly projectNames?: ReadonlyMap<string, string>;
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

/**
 * Narrow the list by project and by what was typed.
 *
 * Pure and beside `orderForPicker` rather than inside the component, for the
 * same reason that one is: it is a rule about two indices and a string, and it
 * can be written down without a DOM.
 *
 * Matching is accent- and case-insensitive. Card titles here are written by
 * people in Portuguese as often as in English — requiring someone to type
 * "manutenção" exactly, accent and all, to find their own card is a search box
 * that punishes you for using it.
 */
export function filterForPicker(
  items: readonly AgEnFKItem[],
  opts: { projectId?: string; query?: string } = {},
): AgEnFKItem[] {
  const needle = fold(opts.query ?? '');
  return items.filter(item => {
    if (opts.projectId && item.projectId !== opts.projectId) return false;
    if (!needle) return true;
    return fold(item.title).includes(needle);
  });
}

/** Lowercase, accents stripped. `NFD` splits a letter from its mark so the mark can go. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function CardPicker({ items, currentItemId, projectNames, onPick, onClose }: CardPickerProps) {
  const [query, setQuery] = React.useState('');
  const [projectId, setProjectId] = React.useState<string>('');

  /*
   * Filter FIRST, then order. The other way round would sort a list that is
   * about to shrink, and the current card's place at the top only means
   * anything among the cards actually on offer.
   */
  const ordered = React.useMemo(
    () => orderForPicker(filterForPicker(items, { projectId, query }), currentItemId),
    [items, currentItemId, projectId, query],
  );

  /*
   * Projects taken from the cards themselves, not from the full project list:
   * offering a project with nothing in flight is a filter that can only ever
   * empty the list.
   */
  const projectOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) {
      if (!seen.has(item.projectId)) seen.set(item.projectId, projectNames?.get(item.projectId) ?? item.projectId);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, projectNames]);

  return (
    <div className="fixed inset-0 z-50 flex animate-[fadeIn_120ms_ease-out] items-center justify-center bg-black/50 p-4 motion-reduce:animate-none">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Open a terminal on which card"
        ref={el => el?.focus()}
        // Focusable, or the handler below can never run: React dispatches
        // keydown along the fiber tree from the EVENT TARGET, and after
        // clicking `+` the focus is still on that button — which is not inside
        // this dialog. The first version asserted the Escape win in a comment
        // and shipped a handler nothing could reach; its test fired the event
        // at the dialog directly and so could not see that.
        tabIndex={-1}
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

        {/* Only when there is something to narrow. A search box over three
            cards is furniture, and a project filter with one project in it can
            only ever do nothing. */}
        {(items.length > 6 || projectOptions.length > 1) && (
          <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
            <input
              type="search"
              value={query}
              autoFocus
              onChange={e => setQuery(e.target.value)}
              aria-label="Search cards by name"
              placeholder="Search cards…"
              className="min-w-0 flex-1 rounded-md border border-border-soft bg-canvas px-2 py-1 text-[11px] text-ink placeholder:text-ink-tertiary focus:border-border-brand focus:outline-none"
            />
            {projectOptions.length > 1 && (
              <select
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                aria-label="Filter by project"
                className="shrink-0 rounded-md border border-border-soft bg-canvas px-2 py-1 text-[11px] text-ink-secondary focus:border-border-brand focus:outline-none"
              >
                <option value="">All projects</option>
                {projectOptions.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {ordered.length === 0 && (query || projectId) ? (
            /*
             * A search that found nothing is NOT "no work in flight". Saying
             * the latter here would tell the user their board is empty when
             * they simply mistyped, which is the kind of confident wrong
             * answer that makes people stop trusting a filter.
             */
            <p className="px-3 py-6 text-center text-xs text-ink-tertiary">
              No card matches that. Clear the search or pick another project.
            </p>
          ) : ordered.length === 0 ? (
            /*
             * A sentence, not an empty box. Reachable when every card has left
             * the active-work list while a terminal outlives it, and "nothing
             * is in flight" tells the user what to do next where a blank panel
             * would not.
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
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs text-ink">{item.title}</span>
                      {projectNames?.get(item.projectId) && (
                        <span className="truncate text-[10px] text-ink-tertiary">
                          {projectNames.get(item.projectId)}
                        </span>
                      )}
                    </span>
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
