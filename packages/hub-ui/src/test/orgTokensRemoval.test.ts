import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ORG_PAGE_SRC = readFileSync(
  path.resolve(__dirname, '../pages/Org.tsx'),
  'utf8',
);
const TILES_SRC = readFileSync(
  path.resolve(__dirname, '../components/MetricsTilesRow.tsx'),
  'utf8',
);

describe('Org rollup dashboard — token telemetry removed', () => {
  it('does not render token tiles in MetricsTilesRow', () => {
    expect(TILES_SRC).not.toMatch(/Tokens in/i);
    expect(TILES_SRC).not.toMatch(/Tokens out/i);
    expect(TILES_SRC).not.toMatch(/Token usage/i);
  });

  it('Org.tsx does not include token totals in the reducer', () => {
    expect(ORG_PAGE_SRC).not.toMatch(/tokensIn/);
    expect(ORG_PAGE_SRC).not.toMatch(/tokensOut/);
  });
});
