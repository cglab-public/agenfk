import { KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { cn } from './cn';

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Danger items read as destructive on hover. */
  tone?: 'default' | 'danger';
}

/** Room the menu needs below its button before it opens upwards instead. */
const FLIP_BELOW_PX = 160;

/**
 * A row's actions behind one "…" button, so a table row carries one control
 * instead of a strip of them. `label` names the row ("Actions for Carol
 * Diaz") and every item says what it does to whom.
 *
 * The menu is portalled and fixed-positioned: tables sit in overflow-x
 * scrollers, which clip anything absolutely positioned inside them, and the
 * last row's menu would otherwise open into a scrollbar. It follows the
 * WAI-ARIA menu button pattern: opening focuses the first item, arrows /
 * Home / End move between items, Escape or Tab closes it, and closing
 * returns focus to the button.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number }>({ right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const itemEls = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const close = (returnFocus = true) => { setOpen(false); if (returnFocus) buttonRef.current?.focus(); };

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    setPos(window.innerHeight - r.bottom < FLIP_BELOW_PX
      ? { bottom: window.innerHeight - r.top + 4, right }
      : { top: r.bottom + 4, right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // preventScroll: the menu may not have its position yet on this frame.
    itemEls()[0]?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    // A fixed menu would drift from its row as the page or table scrolls.
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (items.length === 0) return null;

  const onMenuKey = (e: KeyboardEvent) => {
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); els[(n + els.length) % els.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    // Back to the button, then the browser's own Tab moves on from there: the
    // menu is portalled to the end of <body>, so tabbing out of it directly
    // would leave the page.
    else if (e.key === 'Tab') close();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'Escape' && open) { e.preventDefault(); close(); }
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); setOpen(true); }
        }}
        className="rounded-md p-1 text-ink-tertiary hover:bg-accent-fill hover:text-ink"
      >
        <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right }}
          className="z-50 min-w-[14rem] rounded-lg border border-border-soft bg-surface py-1 text-left shadow-lg"
        >
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => { close(); item.onSelect(); }}
              className={cn(
                'block w-full px-3 py-1.5 text-left text-body text-ink-secondary focus:outline-none disabled:opacity-50',
                item.tone === 'danger'
                  ? 'hover:bg-status-danger-bg hover:text-status-danger-text focus:bg-status-danger-bg focus:text-status-danger-text'
                  : 'hover:bg-accent-fill hover:text-ink focus:bg-accent-fill focus:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
