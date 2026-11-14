/**
 * @vitest-environment jsdom
 *
 * One date rule across the hub (story 12753604): times are shown in the
 * viewer's local zone with the UTC instant on hover, dates use one unambiguous
 * format, and a custom range is picked with one DateRange component (paired
 * From/To, a clear button) on PR overview and the user page alike.
 *
 * Expectations are computed with the same Intl calls rather than spelled out,
 * so the file passes in any zone and locale the suite runs under.
 */
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DateRange, LocalTime } from '../components/ui';
import { fmtDate, fmtDateTime, utcTitle, startOfLocalDay, endOfLocalDay, isDateInput } from '../dates';
import { buildDayAxis } from '../prOverview';
import { PrOverviewPage } from '../pages/PrOverview';
import { UserDetailPage } from '../pages/UserDetail';
import { AdminInstallations } from '../pages/Admin';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

afterEach(() => { cleanup(); get.mockReset(); });

describe('dates', () => {
  it('fmtDate is the one unambiguous format: day, short month name, year', () => {
    const iso = '2026-09-30T12:00:00Z';
    const expected = new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    expect(fmtDate(iso)).toBe(expected);
    // Never all digits: 9/30/2026 and 30/09/2026 are the ambiguity this removes.
    expect(fmtDate(iso)).toMatch(/\p{L}/u);
    expect(fmtDate(iso)).toContain('2026');
  });

  it('utcTitle spells the UTC instant, for ISO and SQLite timestamps alike', () => {
    expect(utcTitle('2026-09-30T22:14:05.123Z')).toBe('2026-09-30 22:14:05 UTC');
    expect(utcTitle('2026-09-30 22:14:05')).toBe('2026-09-30 22:14:05 UTC');
    expect(utcTitle('not a date')).toBe('');
  });

  it('refuses a date input that is not a real YYYY-MM-DD, instead of throwing', () => {
    for (const bad of ['garbage', '2026-13-01', '2026-02-30', '', '2026-8-1']) {
      expect(isDateInput(bad)).toBe(false);
      expect(startOfLocalDay(bad)).toBe('');
      expect(endOfLocalDay(bad)).toBe('');
    }
    expect(isDateInput('2026-02-28')).toBe(true);
  });

  it('a date input bounds a LOCAL day', () => {
    expect(startOfLocalDay('2026-08-10')).toBe(new Date('2026-08-10T00:00:00').toISOString());
    expect(endOfLocalDay('2026-08-12')).toBe(new Date('2026-08-12T23:59:59.999').toISOString());
  });
});

describe('LocalTime', () => {
  it('shows local time and the UTC instant on hover', () => {
    render(<LocalTime value="2026-08-13T16:50:18Z" />);
    const t = document.querySelector('time') as HTMLElement;
    expect(t).toHaveAttribute('dateTime', '2026-08-13T16:50:18.000Z');
    expect(t).toHaveAttribute('title', '2026-08-13 16:50:18 UTC');
    expect(t).toHaveTextContent(fmtDateTime('2026-08-13T16:50:18Z'));
  });

  it('shows a date in the one date format', () => {
    render(<LocalTime value="2026-08-13T16:50:18Z" format="date" />);
    expect(document.querySelector('time')).toHaveTextContent(fmtDate('2026-08-13T16:50:18Z'));
  });

  it('falls back to the raw text for something that is not a time', () => {
    render(<LocalTime value="garbage" />);
    expect(screen.getByText('garbage')).toBeInTheDocument();
    expect(document.querySelector('time')).toBeNull();
  });
});

describe('buildDayAxis in the viewer zone', () => {
  it('lists the local calendar days of the window, by the zone’s own rules', () => {
    // 2026-08-10 00:00 → 2026-08-12 23:59 in Berlin (CEST, UTC+2).
    expect(buildDayAxis('2026-08-09T22:00:00.000Z', '2026-08-12T21:59:59.999Z', 'Europe/Berlin'))
      .toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    // The same instants read in UTC start a day early.
    expect(buildDayAxis('2026-08-09T22:00:00.000Z', '2026-08-12T21:59:59.999Z', 'UTC'))
      .toEqual(['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']);
    // West of UTC.
    expect(buildDayAxis('2026-08-10T07:00:00.000Z', '2026-08-11T06:59:59.999Z', 'America/Los_Angeles'))
      .toEqual(['2026-08-10']);
  });

  it('does not grow a column for a range on the other side of a DST change', () => {
    // A January range in Berlin is CET (UTC+1), whatever the offset is today.
    // Reading it with a single summer offset (+2) added a phantom 01-13.
    expect(buildDayAxis('2026-01-09T23:00:00.000Z', '2026-01-12T22:59:59.999Z', 'Europe/Berlin'))
      .toEqual(['2026-01-10', '2026-01-11', '2026-01-12']);
    // Spanning the March change itself: one column per calendar day.
    expect(buildDayAxis('2026-03-27T23:00:00.000Z', '2026-03-30T21:59:59.999Z', 'Europe/Berlin'))
      .toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
  });

  it('is empty, not a crash, for an instant that does not parse', () => {
    expect(buildDayAxis('garbage', '2026-08-10T00:00:00.000Z', 'UTC')).toEqual([]);
  });

  it('defaults to UTC days', () => {
    expect(buildDayAxis('2026-08-09T22:00:00.000Z', '2026-08-10T01:00:00.000Z'))
      .toEqual(['2026-08-09', '2026-08-10']);
  });
});

describe('fmtDateTime', () => {
  it('names the year when it is not this year', () => {
    const old = '2024-03-05T10:00:00Z';
    expect(fmtDateTime(old)).toContain('2024');
    const now = new Date();
    expect(fmtDateTime(now)).not.toContain(String(now.getFullYear()));
  });
});

describe('DateRange', () => {
  function Harness({ initial = ['', ''] as [string, string], disabled = false, onChange = vi.fn() }) {
    const [[from, to], set] = useState(initial);
    return <DateRange from={from} to={to} disabled={disabled} onChange={(f, t) => { onChange(f, t); set([f, t]); }} />;
  }

  it('pairs the two inputs so To cannot precede From', () => {
    render(<Harness initial={['2026-08-10', '2026-08-12']} />);
    expect(screen.getByLabelText('From date')).toHaveAttribute('max', '2026-08-12');
    expect(screen.getByLabelText('To date')).toHaveAttribute('min', '2026-08-10');
  });

  it('reports each side and keeps the other', () => {
    const onChange = vi.fn();
    render(<Harness initial={['2026-08-10', '']} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-15' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-08-10', '2026-08-15');
  });

  it('keeps the clear in place but disabled while nothing is set, clears both, and returns focus to From', () => {
    const onChange = vi.fn();
    render(<Harness initial={['', '']} onChange={onChange} />);
    // Always rendered, so clearing does not drop keyboard focus onto <body>.
    expect(screen.getByRole('button', { name: 'Clear date range' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-10' } });
    const clear = screen.getByRole('button', { name: 'Clear date range' });
    expect(clear).toBeEnabled();
    clear.focus();
    fireEvent.click(clear);
    expect(onChange).toHaveBeenLastCalledWith('', '');
    expect(screen.getByLabelText('From date')).toHaveValue('');
    expect(screen.getByLabelText('From date')).toHaveFocus();
  });

  it('shows visible From and To captions', () => {
    render(<Harness />);
    expect(screen.getByText('From')).toBeVisible();
    expect(screen.getByText('To')).toBeVisible();
  });

  it('disables every control', () => {
    render(<Harness initial={['2026-08-10', '']} disabled />);
    expect(screen.getByLabelText('From date')).toBeDisabled();
    expect(screen.getByLabelText('To date')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear date range' })).toBeDisabled();
  });
});

const overviewFixture = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-12T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 0, sizePoints: 0, developers: 0, medianBucket: null },
  resized: { count: 0, grew: 0, shrank: 0 },
  byDay: [], byDeveloper: [], byModel: [], prs: [], previous: null,
};

const mount = (el: React.ReactElement, entry: string, path = '*') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let loc = '';
  function Where() { loc = useLocation().search; return null; }
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes><Route path={path} element={el} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => new URLSearchParams(loc);
};

describe('PR overview reads the period in the viewer zone', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
      return { data: overviewFixture };
    });
  });
  const overviewCall = () => {
    const hit = get.mock.calls.map(c => String(c[0])).find(u => u.startsWith('/v1/prs/overview'))!;
    return new URLSearchParams(hit.split('?')[1]);
  };

  it('sends the browser zone so the server buckets local days', async () => {
    mount(<PrOverviewPage />, '/prs');
    await screen.findByText(/No PRs/);
    expect(overviewCall().get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // And the offset, for a server that does not know the zone.
    expect(overviewCall().get('tzOffsetMin')).toBe(String(-new Date().getTimezoneOffset()));
  });

  it('ignores a malformed date in a shared link instead of crashing', async () => {
    mount(<PrOverviewPage />, '/prs?from=garbage&to=2026-13-01');
    await screen.findByText(/No PRs/);
    expect(overviewCall().get('to')).toBeNull();
    expect(overviewCall().get('from')).not.toMatch(/garbage|Invalid/);
    // The preset that applies is the one shown pressed.
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  });

  describe('in a zone east of UTC', () => {
    const saved = process.env.TZ;
    beforeEach(() => { process.env.TZ = 'Europe/Berlin'; });
    afterEach(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });

    it('bounds a custom range by local days, not UTC days', async () => {
      mount(<PrOverviewPage />, '/prs?from=2026-08-10&to=2026-08-12');
      await screen.findByText(/No PRs/);
      // Spelled out, so the test cannot pass on a UTC machine by coincidence.
      expect(overviewCall().get('from')).toBe('2026-08-09T22:00:00.000Z');
      expect(overviewCall().get('to')).toBe('2026-08-12T21:59:59.999Z');
      expect(overviewCall().get('tz')).toBe('Europe/Berlin');
    });
  });

  it('picks the custom range with DateRange', async () => {
    mount(<PrOverviewPage />, '/prs?from=2026-08-10');
    await screen.findByText(/No PRs/);
    expect(screen.getByLabelText('To date')).toHaveAttribute('min', '2026-08-10');
    expect(screen.getByRole('button', { name: 'Clear date range' })).toBeInTheDocument();
  });
});

describe('the user page uses the same period controls', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
  });

  it('pairs From/To, clears both, and names the group once', async () => {
    const search = mount(<UserDetailPage />, '/users/alice%40acme.com?from=2026-08-10&to=2026-08-12', '/users/:userKey');
    const group = await screen.findByRole('group', { name: 'Period' });
    expect(group).toHaveAttribute('aria-labelledby');
    const g = within(group);
    expect(g.getByLabelText('From date')).toHaveAttribute('max', '2026-08-12');
    expect(g.getByLabelText('To date')).toHaveAttribute('min', '2026-08-10');
    fireEvent.click(g.getByRole('button', { name: 'Clear date range' }));
    expect(search().get('from')).toBeNull();
    expect(search().get('to')).toBeNull();
  });
});

describe('the user page survives a malformed date in a shared link', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
  });
  it('renders, and falls back to the preset window', async () => {
    mount(<UserDetailPage />, '/users/alice%40acme.com?from=garbage', '/users/:userKey');
    expect(await screen.findByRole('group', { name: 'Period' })).toBeInTheDocument();
    const tl = get.mock.calls.map(c => String(c[0])).find(u => u.startsWith('/v1/timeline'))!;
    const from = new URLSearchParams(tl.split('?')[1]).get('from');
    // The 30d preset's start, not the link's garbage.
    expect(from === null || Number.isFinite(Date.parse(from))).toBe(true);
    expect(tl).not.toMatch(/garbage/);
  });
});

describe('Installations dates follow the rule', () => {
  it('shows last seen in the date format, UTC on hover', async () => {
    const lastSeen = '2026-09-29T08:00:00.000Z';
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/admin/installations')) return { data: [
        { id: '3f0c1a2b-1111-4222-8333-944445555666', agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: lastSeen, firstSeen: lastSeen, lastSeen, osUser: 'carol', gitName: 'Carol', gitEmail: 'carol@acme.dev' },
      ] };
      return { data: [] };
    });
    mount(<AdminInstallations />, '/');
    await screen.findByText('Carol');
    const times = [...document.querySelectorAll('time')];
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (const t of times) {
      expect(t).toHaveAttribute('title', '2026-09-29 08:00:00 UTC');
      expect(t).toHaveTextContent(fmtDate(lastSeen));
    }
  });
});
