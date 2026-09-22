import React from 'react';
import { ItemType } from '../types';
import { ITEM_TYPES, ItemTypeSquare, itemTypeHint } from './ItemTypeSquare';

/**
 * Choosing what kind of work this is, with the four kinds actually shown.
 *
 * It was a native `<select>` whose options were four bare words. Two things
 * were wrong with that, and the second is why a custom control is worth the
 * code: an `<option>` cannot render the coloured square that every tracker
 * uses to say "issue type" — the shape-and-colour pairing is what gets read
 * before the word does — and it cannot carry the sentence saying what
 * choosing that type MEANS. So the difference between an EPIC and a TASK was
 * invisible at the moment of choosing, and visible only afterwards, one line
 * down, for the option already picked.
 *
 * NOT SHOWN, though the design asked for it: "a task gets a worktree and a
 * branch, an epic does not". `packages/server/src/worktrees.ts` does not look
 * at item type anywhere, so that line would be the UI promising a rule the
 * server does not keep. The hints here are the ones `itemTypeHint` already
 * checks against what the product actually enforces.
 */
export interface ItemTypePickerProps {
  readonly value: ItemType;
  readonly onChange: (type: ItemType) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
  /**
   * The element describing what the CURRENT type means.
   *
   * Every option carries its own sentence, but the closed control must still
   * describe itself: the hint lives several elements away in the DOM, so
   * without this it is reachable only in browse mode — never on focus, which
   * is when it is needed.
   */
  readonly describedBy?: string;
}

export function ItemTypePicker({ value, onChange, disabled, testId = 'item-type-picker', describedBy }: ItemTypePickerProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Click-away and Escape both shut it. A popover that can only be dismissed
  // by choosing something is a dialog wearing a dropdown's clothes.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (type: ItemType) => { onChange(type); setOpen(false); };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Type"
        aria-describedby={describedBy}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          // Arrow keys move through the list the way a select does, without
          // opening it first — the habit a native control teaches.
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const i = ITEM_TYPES.indexOf(value);
            const next = e.key === 'ArrowDown'
              ? ITEM_TYPES[Math.min(i + 1, ITEM_TYPES.length - 1)]
              : ITEM_TYPES[Math.max(i - 1, 0)];
            onChange(next);
          }
        }}
        className="flex items-center gap-1.5 rounded-md border border-border-soft bg-surface px-2 py-1 text-xs font-bold text-ink focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
      >
        <ItemTypeSquare type={value} testId={`${testId}-square`} />
        {value}
        <span aria-hidden="true" className="text-ink-tertiary">▾</span>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Type"
          data-testid={`${testId}-options`}
          className="absolute left-0 z-20 mt-1 w-72 overflow-hidden rounded-xl border border-border-soft bg-surface shadow-2xl"
        >
          {ITEM_TYPES.map(type => (
            <li key={type}>
              <button
                type="button"
                role="option"
                aria-selected={type === value}
                data-testid={`${testId}-option-${type}`}
                onClick={() => choose(type)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-chip ${type === value ? 'bg-chip' : ''}`}
              >
                <ItemTypeSquare type={type} />
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-ink">{type}</span>
                  {/* What choosing it means, on every option — not only on the
                      one already chosen. */}
                  <span className="block text-[11px] leading-snug text-ink-tertiary">{itemTypeHint(type)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
