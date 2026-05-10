import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const USER_DETAIL_SRC = readFileSync(
  path.resolve(__dirname, '../pages/UserDetail.tsx'),
  'utf8',
);
const ORG_SRC = readFileSync(
  path.resolve(__dirname, '../pages/Org.tsx'),
  'utf8',
);

describe('UserDetail — metrics tiles row', () => {
  it('fetches /v1/metrics filtered by user', () => {
    expect(USER_DETAIL_SRC).toMatch(/v1\/metrics/);
    expect(USER_DETAIL_SRC).toMatch(/users.*decoded|decoded.*users/);
  });

  it('renders a MetricsTilesRow or equivalent tile grid', () => {
    expect(USER_DETAIL_SRC).toMatch(/MetricsTilesRow|<Tile/);
  });

  it('shows tokens in/out tiles', () => {
    expect(USER_DETAIL_SRC).toMatch(/[Tt]okens.in/i);
    expect(USER_DETAIL_SRC).toMatch(/[Tt]okens.out/i);
  });

  it('shows prs_opened / PRs tile', () => {
    expect(USER_DETAIL_SRC).toMatch(/prsOpened|prs_opened|PRs/i);
  });
});

describe('Org — prs_opened tile', () => {
  it('includes prsOpened in the totals reducer', () => {
    expect(ORG_SRC).toMatch(/prsOpened/);
  });

  it('renders a PRs tile label', () => {
    expect(ORG_SRC).toMatch(/PRs/i);
  });
});

describe('MetricsTilesRow shared component', () => {
  it('exists as a shared component file', () => {
    expect(() =>
      readFileSync(path.resolve(__dirname, '../components/MetricsTilesRow.tsx'), 'utf8')
    ).not.toThrow();
  });

  it('exports MetricsTilesRow', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../components/MetricsTilesRow.tsx'),
      'utf8',
    );
    expect(src).toMatch(/export.*MetricsTilesRow/);
  });
});
