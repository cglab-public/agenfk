import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

describe('Hub UI token telemetry removal', () => {
  it('does not advertise tokens.logged in the event-type catalog', () => {
    expect(read('eventTypes.ts')).not.toMatch(/tokens\.logged/);
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
