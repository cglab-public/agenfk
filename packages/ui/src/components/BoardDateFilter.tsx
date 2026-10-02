import React, { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { clsx } from 'clsx';
import {
  type DateField,
  type DateFilter,
  type DateRange,
  announceDateFilter,
  describeDateFilter,
  isDateFilterActive,
} from '../boardDateFilter';

const FIELDS: { field: DateField; label: string }[] = [
  { field: 'createdAt', label: 'Created' },
  { field: 'updatedAt', label: 'Updated' },
];

// Custom starts with both ends open; its From/To inputs then fill them in.
const PRESETS: { range: DateRange; label: string }[] = [
  { range: { kind: 'any' }, label: 'Any time' },
  { range: { kind: 'today' }, label: 'Today' },
  { range: { kind: 'last7' }, label: 'Last 7 days' },
  { range: { kind: 'last30' }, label: 'Last 30 days' },
  { range: { kind: 'custom' }, label: 'Custom' },
];

const segmentClass = (on: boolean) => clsx(
  'px-2.5 py-1 rounded-lg text-xs transition-all whitespace-nowrap',
  on
    ? 'bg-accent-fill text-accent-ink font-bold'
    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
);

interface Props {
  value: DateFilter;
  onChange: (next: DateFilter) => void;
}

// The board's Created/Updated date filter (CGLAB-444): a trigger that opens a
// small panel (field toggle, range presets, custom from/to), plus a clearable
// chip while a filter is active. Dismissal follows the card "Move to project"
// menu in KanbanBoard: outside pointerdown or Escape closes it.
export const BoardDateFilter: React.FC<Props> = ({ value, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Announce every change of filter, whoever made it (this control, or the
  // board lifting it for a search). The first value is not a change, so
  // mounting does not say "cleared".
  const valueKey = JSON.stringify(value);
  const lastValueKey = useRef(valueKey);
  useEffect(() => {
    if (valueKey === lastValueKey.current) return;
    lastValueKey.current = valueKey;
    setAnnouncement(announceDateFilter(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const setRange = (range: DateRange) => {
    if (range.kind === value.range.kind) return;
    onChange({ ...value, range });
  };

  const setCustomEnd = (end: 'from' | 'to', day: string) => {
    const current = value.range.kind === 'custom' ? value.range : { kind: 'custom' as const };
    const range: DateRange = { ...current, [end]: day || undefined };
    onChange({ ...value, range });
  };

  const active = isDateFilterActive(value);
  const custom = value.range.kind === 'custom' ? value.range : null;

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Date filter"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={() => setIsOpen(open => !open)}
        className={clsx(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors',
          active
            ? 'text-accent-ink bg-accent-fill border border-accent'
            : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
        )}
      >
        <CalendarDays size={14} />
        <span className="hidden sm:inline">Date</span>
      </button>

      {active && (
        <span
          data-testid="date-filter-chip"
          className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-bold bg-accent-fill text-accent-ink border border-accent whitespace-nowrap"
        >
          {describeDateFilter(value)}
          <button
            type="button"
            aria-label="Clear date filter"
            onClick={() => {
              onChange({ ...value, range: { kind: 'any' } });
              // The chip (and this button) unmount; keep focus in the control.
              triggerRef.current?.focus();
            }}
            className="p-0.5 rounded-full hover:bg-canvas"
          >
            <X size={12} />
          </button>
        </span>
      )}

      {isOpen && (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label="Date filter options"
          className="absolute right-0 top-full mt-2 z-50 w-72 bg-surface border border-border-soft rounded-lg shadow-lg p-3 flex flex-col gap-3"
        >
          <div role="group" aria-label="Date field" className="flex gap-1">
            {FIELDS.map(({ field, label }) => (
              <button
                key={field}
                type="button"
                aria-pressed={value.field === field}
                onClick={() => value.field !== field && onChange({ ...value, field })}
                className={segmentClass(value.field === field)}
              >
                {label}
              </button>
            ))}
          </div>

          <div role="group" aria-label="Date range" className="flex flex-wrap gap-1">
            {PRESETS.map(({ range, label }) => (
              <button
                key={range.kind}
                type="button"
                aria-pressed={value.range.kind === range.kind}
                onClick={() => setRange(range)}
                className={segmentClass(value.range.kind === range.kind)}
              >
                {label}
              </button>
            ))}
          </div>

          {custom && (
            <div className="flex gap-2 text-xs text-slate-600 dark:text-slate-300">
              <label className="flex flex-col gap-1 flex-1">
                From
                <input
                  type="date"
                  value={custom.from ?? ''}
                  onChange={e => setCustomEnd('from', e.target.value)}
                  className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent"
                />
              </label>
              <label className="flex flex-col gap-1 flex-1">
                To
                <input
                  type="date"
                  value={custom.to ?? ''}
                  onChange={e => setCustomEnd('to', e.target.value)}
                  className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent"
                />
              </label>
            </div>
          )}
        </div>
      )}

      <span data-testid="date-filter-announcement" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
};
