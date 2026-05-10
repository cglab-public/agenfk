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

describe('Org rollup dashboard — tokens in/out tiles present', () => {
  it('renders a "Tokens in" tile (via MetricsTilesRow)', () => {
    expect(TILES_SRC).toMatch(/Tokens in/i);
  });

  it('renders a "Tokens out" tile (via MetricsTilesRow)', () => {
    expect(TILES_SRC).toMatch(/Tokens out/i);
  });

  it('Org.tsx references tokensIn / tokensOut in the totals reducer', () => {
    expect(ORG_PAGE_SRC).toMatch(/tokensIn/);
    expect(ORG_PAGE_SRC).toMatch(/tokensOut/);
  });
});
