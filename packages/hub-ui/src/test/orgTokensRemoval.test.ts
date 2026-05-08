import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ORG_PAGE_SRC = readFileSync(
  path.resolve(__dirname, '../pages/Org.tsx'),
  'utf8',
);

describe('Org rollup dashboard — tokens in/out tiles removed', () => {
  it('does not render a "Tokens in" tile', () => {
    expect(ORG_PAGE_SRC).not.toMatch(/Tokens in/i);
  });

  it('does not render a "Tokens out" tile', () => {
    expect(ORG_PAGE_SRC).not.toMatch(/Tokens out/i);
  });

  it('does not reference tokensIn / tokensOut in the totals reducer', () => {
    expect(ORG_PAGE_SRC).not.toMatch(/tokensIn/);
    expect(ORG_PAGE_SRC).not.toMatch(/tokensOut/);
  });
});
