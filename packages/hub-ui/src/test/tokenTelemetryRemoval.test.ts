import { describe, expect, it } from 'vitest';
import { KNOWN_EVENT_TYPES, eventTypeLabel, groupEventTypes, mergeEventTypes } from '../eventTypes';

describe('Hub UI token telemetry removal', () => {
  it('does not advertise tokens.logged in the event-type catalog', () => {
    // Behaviour, not source text: the filter never offers it and it has no label.
    expect(mergeEventTypes([])).not.toContain('tokens.logged');
    expect(KNOWN_EVENT_TYPES).not.toContain('tokens.logged' as never);
    expect(eventTypeLabel('tokens.logged')).toBe('tokens.logged');
    expect(groupEventTypes(['tokens.logged'])).toEqual([{ group: 'Other', types: ['tokens.logged'] }]);
  });
});
