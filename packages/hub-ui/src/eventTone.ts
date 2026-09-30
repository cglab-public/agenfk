// Badge tones for events and item types on the user page (CGLAB-434). State
// takes the reserved status tones; work-item lifecycle takes the accent;
// everything else is neutral - no colour without a meaning.
import type { BadgeTone } from './components/ui';

const TONE: Record<string, BadgeTone> = {
  'validate.passed': 'ok',
  'validate.failed': 'danger',
  'item.deleted': 'danger',
  'item.created': 'accent',
  'item.updated': 'accent',
  'item.moved': 'accent',
  'item.closed': 'accent',
  'step.transitioned': 'accent',
};

export const eventTone = (type: string): BadgeTone => TONE[type] ?? 'neutral';

const ITEM_TYPE: Record<string, string> = {
  EPIC: 'text-type-epic border-type-epic/40 bg-type-epic/10',
  STORY: 'text-type-story border-type-story/40 bg-type-story/10',
  TASK: 'text-type-task border-type-task/40 bg-type-task/10',
  BUG: 'text-type-bug border-type-bug/40 bg-type-bug/10',
};

/** Classes for an item-type chip (EPIC/STORY/TASK/BUG); neutral for anything else. */
export const itemTypeClass = (itemType: string): string => ITEM_TYPE[itemType] ?? 'text-ink-secondary border-border-soft bg-canvas';
