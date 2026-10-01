import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { KNOWN_EVENT_TYPES, eventTypeLabel, groupEventTypes, mergeEventTypes } from '../eventTypes';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

describe('Hub UI token telemetry removal', () => {
  it('does not advertise tokens.logged in the event-type catalog', () => {
    // Behaviour, not source text: the filter never offers it and it has no label.
    expect(mergeEventTypes([])).not.toContain('tokens.logged');
    expect(KNOWN_EVENT_TYPES).not.toContain('tokens.logged' as never);
    expect(eventTypeLabel('tokens.logged')).toBe('tokens.logged');
    expect(groupEventTypes(['tokens.logged'])).toEqual([{ group: 'Other', types: ['tokens.logged'] }]);
  });

  it('does not render token usage metrics or timeline modes', () => {
    const metricsTiles = read('components/MetricsTilesRow.tsx');
    const timeline = read('components/TimelineBar.tsx');
    const org = read('pages/Org.tsx');
    const userDetail = read('pages/UserDetail.tsx');

    for (const src of [metricsTiles, timeline, org, userDetail]) {
      expect(src).not.toMatch(/tokensIn|tokensOut|tokens_in|tokens_out/);
      expect(src).not.toMatch(/Token usage|Tokens in|Tokens out/);
      expect(src).not.toMatch(/tokenSeries/);
    }
  });
});
