import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const TILES_SRC = readFileSync(
  path.resolve(__dirname, '../components/MetricsTilesRow.tsx'),
  'utf8',
);

describe('MetricsTilesRow without token telemetry', () => {
  it('does not render token usage controls or labels', () => {
    expect(TILES_SRC).not.toMatch(/TokenUsageTile/);
    expect(TILES_SRC).not.toMatch(/Token usage/i);
    expect(TILES_SRC).not.toMatch(/Tokens in/i);
    expect(TILES_SRC).not.toMatch(/Tokens out/i);
    expect(TILES_SRC).not.toMatch(/tokensIn|tokensOut/);
  });
});
