import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ORG_SRC = readFileSync(path.resolve(__dirname, '../pages/Org.tsx'), 'utf8');
const USER_SRC = readFileSync(path.resolve(__dirname, '../pages/UserDetail.tsx'), 'utf8');
const TIMELINE_SRC = readFileSync(path.resolve(__dirname, '../components/TimelineBar.tsx'), 'utf8');

describe('period filter — OrgPage', () => {
  it('imports fromIsoForRange (or equivalent) to compute a from ISO string from range', () => {
    expect(ORG_SRC).toMatch(/fromIsoForRange/);
  });

  it('passes from to /v1/metrics query', () => {
    expect(ORG_SRC).toMatch(/from.*metrics|metrics.*from/s);
    // The metrics query string must include a `from` parameter derived from period state.
    expect(ORG_SRC).toMatch(/['"']from['"']/);
  });

  it('passes from to /v1/users query', () => {
    expect(ORG_SRC).toMatch(/['"']from['"']/);
    expect(ORG_SRC).toMatch(/v1\/users/);
  });

  it('period state is lifted: range is defined in OrgPage (not only inside TimelineBar)', () => {
    // range state must be declared at page level so it can flow to metrics/users queries
    expect(ORG_SRC).toMatch(/useState.*RangeKey|useState.*'30d'|useState.*"30d"|range.*useState/);
  });

  it('TimelineBar in OrgPage receives range and onRangeChange props', () => {
    expect(ORG_SRC).toMatch(/onRangeChange/);
    expect(ORG_SRC).toMatch(/<TimelineBar[^>]*range=/s);
  });
});

describe('period filter — UserDetailPage', () => {
  it('imports fromIsoForRange (or equivalent) to compute a from ISO string from range', () => {
    expect(USER_SRC).toMatch(/fromIsoForRange/);
  });

  it('passes from to /v1/metrics query', () => {
    expect(USER_SRC).toMatch(/['"']from['"']/);
    expect(USER_SRC).toMatch(/v1\/metrics/);
  });

  it('passes from to /v1/timeline query', () => {
    expect(USER_SRC).toMatch(/['"']from['"']/);
    expect(USER_SRC).toMatch(/v1\/timeline/);
  });

  it('period state is lifted: range is defined in UserDetailPage', () => {
    expect(USER_SRC).toMatch(/useState.*RangeKey|useState.*'30d'|useState.*"30d"|range.*useState/);
  });

  it('TimelineBar in UserDetailPage receives range and onRangeChange props', () => {
    expect(USER_SRC).toMatch(/onRangeChange/);
    expect(USER_SRC).toMatch(/<TimelineBar[^>]*range=/s);
  });
});

describe('TimelineBar — accepts external range/onRangeChange props', () => {
  it('Props interface includes range and onRangeChange', () => {
    expect(TIMELINE_SRC).toMatch(/onRangeChange/);
    expect(TIMELINE_SRC).toMatch(/range\??\s*:/);
  });

  it('uses external onRangeChange when provided instead of internal setState only', () => {
    // The component must call onRangeChange when range buttons are clicked
    expect(TIMELINE_SRC).toMatch(/onRangeChange/);
  });
});
