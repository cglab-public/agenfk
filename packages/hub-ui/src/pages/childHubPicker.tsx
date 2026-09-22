/**
 * Which child hubs a directive goes to: all of them, or a ticked subset.
 *
 * Shared by the flow dispatch (CGLAB-358) and the group upgrade (CGLAB-360)
 * forms, which send the same `scope` / `childHubIds` pair to sibling routes.
 * 'all' is resolved server-side against current AND future children, which is
 * why the caption says so and why the form sends no ids for it.
 *
 * Presentational: the owner holds `mode` and `selected`, because the request
 * body and its validation (flowDispatchBody) live with the owner too.
 */
import { X } from 'lucide-react';
import type { ChildHubRow, DispatchScopeMode } from './flowDispatch';

export function ChildHubPicker({
  childHubs, mode, selected, onMode, onToggle, onClose, testIdPrefix,
}: {
  childHubs: ChildHubRow[];
  mode: DispatchScopeMode;
  selected: Set<string>;
  onMode: (mode: DispatchScopeMode) => void;
  onToggle: (id: string) => void;
  onClose?: () => void;
  /** e.g. 'flow-dispatch' → `flow-dispatch-scope-all`, `flow-dispatch-child-<id>`. */
  testIdPrefix: string;
}) {
  const pill = (active: boolean) =>
    'text-[11px] px-2 py-0.5 rounded-full border transition-colors ' +
    (active ? 'border-brand text-ink bg-chip font-semibold' : 'border-border-soft text-ink-tertiary hover:text-ink');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <button type="button" aria-pressed={mode === 'all'} className={pill(mode === 'all')} onClick={() => onMode('all')} data-testid={`${testIdPrefix}-scope-all`}>
          All child hubs ({childHubs.length})
        </button>
        <button type="button" aria-pressed={mode === 'selected'} className={pill(mode === 'selected')} onClick={() => onMode('selected')} data-testid={`${testIdPrefix}-scope-selected`}>
          Selected ({selected.size})
        </button>
        <span className="flex-1" />
        {onClose && (
          <button type="button" onClick={onClose} className="text-ink-tertiary hover:text-ink" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {mode === 'selected' && (
        <div className="space-y-1">
          {childHubs.map(c => (
            <label key={c.id} className="flex items-center gap-2 text-xs text-ink-secondary">
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => onToggle(c.id)}
                data-testid={`${testIdPrefix}-child-${c.id}`}
              />
              {c.name}
            </label>
          ))}
        </div>
      )}
      {mode === 'all' && (
        <p className="text-[11px] text-ink-tertiary">
          Every current child hub, and any that joins later.
        </p>
      )}
    </div>
  );
}
