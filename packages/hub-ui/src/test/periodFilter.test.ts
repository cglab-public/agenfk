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

  it('renders Period controls in the Filters panel', () => {
    expect(USER_SRC).toMatch(/<h3[^>]*>\s*Period\s*<\/h3>/);
    expect(USER_SRC).toMatch(/RANGES\.map/);
  });

  it('supports explicit custom start and end dates', () => {
    expect(USER_SRC).toMatch(/customStart/);
    expect(USER_SRC).toMatch(/customEnd/);
    expect(USER_SRC).toMatch(/type="date"/);
  });

  it('passes custom from/to dates to user metrics and timeline queries', () => {
    expect(USER_SRC).toMatch(/customFromIso/);
    expect(USER_SRC).toMatch(/customToIso/);
    expect(USER_SRC).toMatch(/p\.set\(['"]from['"],\s*customFromIso/s);
    expect(USER_SRC).toMatch(/p\.set\(['"]to['"],\s*customToIso/s);
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

  it('hides the range picker when range prop is provided (controlled mode)', () => {
    // When range is controlled externally the range button group must not render.
    // Implementation: wrap the range buttons in a conditional on !rangeProp.
    expect(TIMELINE_SRC).toMatch(/rangeProp.*RANGES|!rangeProp|rangeProp == null|rangeProp === undefined/s);
  });

  it('accepts tokenSeries prop for a list of daily token buckets', () => {
    expect(TIMELINE_SRC).toMatch(/tokenSeries/);
  });

  it('accepts explicit from/to bounds for controlled custom date ranges', () => {
    expect(TIMELINE_SRC).toMatch(/fromIsoOverride/);
    expect(TIMELINE_SRC).toMatch(/toIsoOverride/);
    expect(TIMELINE_SRC).toMatch(/params\.set\(['"]from['"],\s*fromIso/s);
    expect(TIMELINE_SRC).toMatch(/params\.set\(['"]to['"],\s*toIsoOverride/s);
  });

  it('renders a mode toggle (events / tokens) when tokenSeries is provided', () => {
    // When tokenSeries prop is present the chart must show a mode toggle.
    expect(TIMELINE_SRC).toMatch(/tokenSeries.*mode|mode.*tokenSeries|'events'.*'tokens'|"events".*"tokens"/s);
  });
});

describe('Org.tsx — range picker in Filters panel', () => {
  it('renders range buttons/chips inside the Filters section (not only in TimelineBar)', () => {
    // The Filters section must contain the period selector so the timeline range
    // picker can be hidden inside TimelineBar.
    // Look for RANGES array reference or inline today/7d/30d/90d in the filters area.
    expect(ORG_SRC).toMatch(/Period|period|RANGES|today.*7d|7d.*30d/);
  });

  it('passes tokenSeries to TimelineBar', () => {
    expect(ORG_SRC).toMatch(/tokenSeries/);
  });
});
