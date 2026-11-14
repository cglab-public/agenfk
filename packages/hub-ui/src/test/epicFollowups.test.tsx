/**
 * @vitest-environment jsdom
 *
 * Follow-ups from the epic-level review of 122e34dc (BUG 088bfe70): one time
 * rule on every surface, no hover that promises a click, and no made-up zone.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataTable } from '../components/ui';
import { browserTimezone } from '../dates';
import { OrgPage } from '../pages/Org';
import { PrOverviewPage } from '../pages/PrOverview';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); vi.restoreAllMocks(); });

const mount = (el: React.ReactElement, entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[entry]}>{el}</MemoryRouter></QueryClientProvider>);
};
const call = (prefix: string) => {
  const hit = get.mock.calls.map(c => String(c[0])).filter(u => u.startsWith(prefix)).pop();
  return hit ? new URLSearchParams(hit.split('?')[1]) : null;
};
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('DataTable', () => {
  it('does not hover-highlight rows unless asked', () => {
    render(<DataTable caption="T" columns={[{ key: 'a', header: 'A', render: (r: { a: string }) => r.a }]} rows={[{ a: 'x' }]} rowKey={r => r.a} />);
    expect(screen.getByRole('row', { name: 'x' }).className).not.toMatch(/hover:/);
  });
});

describe('browserTimezone', () => {
  it('is null, not a made-up UTC, when the browser cannot name its zone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: undefined } as any);
    expect(browserTimezone()).toBeNull();
  });
});

describe('PR overview search keeps the viewer zone', () => {
  it('sends tz and tzOffsetMin with a PR number search', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      return { data: { period: { from: null, to: null }, buckets: [], totals: { prs: 0, sizePoints: 0, developers: 0, medianBucket: null }, resized: { count: 0, grew: 0, shrank: 0 }, byDay: [], byDeveloper: [], byModel: [], prs: [], previous: null } };
    });
    mount(<PrOverviewPage />, '/prs?pr=57');
    // The data request, not the options one the page also makes.
    const search = () => get.mock.calls.map(c => String(c[0]))
      .filter(u => u.startsWith('/v1/prs/overview') && u.includes('pr=57')).pop();
    await waitFor(() => expect(search()).toBeDefined());
    const q = new URLSearchParams(search()!.split('?')[1]);
    expect(q.get('tz')).toBe(ZONE);
    expect(q.get('tzOffsetMin')).toBe(String(-new Date().getTimezoneOffset()));
  });
});

describe('Org asks for per-person closures in the viewer zone', () => {
  it('sends tz to /v1/users', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/users')) return { data: [] };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
    mount(<OrgPage />, '/');
    await waitFor(() => expect(call('/v1/users')).not.toBeNull());
    expect(call('/v1/users')!.get('tz')).toBe(ZONE);
  });
});

describe('PR overview without a nameable zone', () => {
  it('sends neither tz nor an offset, so server and axis both use UTC', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: undefined } as any);
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      return { data: { period: { from: null, to: null }, buckets: [], totals: { prs: 0, sizePoints: 0, developers: 0, medianBucket: null }, resized: { count: 0, grew: 0, shrank: 0 }, byDay: [], byDeveloper: [], byModel: [], prs: [], previous: null } };
    });
    mount(<PrOverviewPage />, '/prs');
    await waitFor(() => expect(call('/v1/prs/overview')).not.toBeNull());
    const q = call('/v1/prs/overview')!;
    expect(q.has('tz')).toBe(false);
    expect(q.has('tzOffsetMin')).toBe(false);
  });
});
