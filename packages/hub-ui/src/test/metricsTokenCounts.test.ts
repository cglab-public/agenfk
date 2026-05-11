import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const TILES_SRC = readFileSync(
  path.resolve(__dirname, '../components/MetricsTilesRow.tsx'),
  'utf8',
);

describe('MetricsTilesRow token count display', () => {
  it('uses a grouped token usage tile instead of separate truncating token tiles', () => {
    expect(TILES_SRC).toMatch(/function\s+TokenUsageTile/);
    expect(TILES_SRC).toMatch(/Token usage/i);
    expect(TILES_SRC).not.toMatch(/<Tile\s+label="Tokens in"/);
    expect(TILES_SRC).not.toMatch(/<Tile\s+label="Tokens out"/);
  });

  it('formats large token counts with compact million-scale notation', () => {
    expect(TILES_SRC).toMatch(/formatCompactTokenCount/);
    expect(TILES_SRC).toMatch(/1_000_000/);
    expect(TILES_SRC).toMatch(/maximumFractionDigits:\s*1/);
  });

  it('keeps exact token counts available while the visible value is compact', () => {
    expect(TILES_SRC).toMatch(/toLocaleString\(\)/);
    expect(TILES_SRC).toMatch(/title=\{.*tokensIn.*toLocaleString\(\)/s);
    expect(TILES_SRC).toMatch(/title=\{.*tokensOut.*toLocaleString\(\)/s);
    expect(TILES_SRC).toMatch(/aria-label=\{.*tokensIn.*toLocaleString\(\)/s);
    expect(TILES_SRC).toMatch(/aria-label=\{.*tokensOut.*toLocaleString\(\)/s);
  });

  it('renders token labels below the values for horizontal value alignment', () => {
    expect(TILES_SRC).toMatch(/mt-2 grid grid-cols-2 gap-3/);
    expect(TILES_SRC).toMatch(/\{formatCompactTokenCount\(tokensIn\)\}[\s\S]*Tokens in/);
    expect(TILES_SRC).toMatch(/\{formatCompactTokenCount\(tokensOut\)\}[\s\S]*Tokens out/);
  });
});
