import { useId } from 'react';
import { Chip, FilterHeading } from './ui';
import { eventTypeLabel, groupEventTypes } from '../eventTypes';

/**
 * The Event type filter: chips in plain words under a few headings (Work items,
 * Checks, …), the raw id on hover. Toggling and clearing work on raw ids, so
 * URLs and queries are unchanged.
 */
export function EventTypeChips({ options, selected, onToggle, onClear }: {
  options: string[];
  selected: Set<string>;
  onToggle: (type: string) => void;
  onClear: () => void;
}) {
  const id = useId();
  if (options.length === 0) return null;
  return (
    <div>
      <FilterHeading id={id} label="Event type" count={selected.size} onClear={onClear} />
      <div role="group" aria-labelledby={id} className="mt-1.5 space-y-2">
        {groupEventTypes(options).map((g, i) => (
          // Ids by position: a heading such as "Work items" has a space, and
          // aria-labelledby reads a space as two ids.
          <div key={g.group} role="group" aria-labelledby={`${id}-g${i}`} className="flex flex-wrap items-center gap-1.5">
            <span id={`${id}-g${i}`} className="w-24 shrink-0 text-caption font-medium text-ink-tertiary">{g.group}</span>
            {g.types.map(t => (
              <Chip key={t} on={selected.has(t)} onClick={() => onToggle(t)} title={t}>{eventTypeLabel(t)}</Chip>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
