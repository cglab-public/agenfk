/**
 * @vitest-environment jsdom
 *
 * Org's Users panel counts what the Event type filter selects. Its "N events"
 * came from /v1/users called without types, so with only item.closed selected
 * a person still read 651 events while the chart above showed their closures.
 * The tiles stay across every event type by design, and now say so.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgPage } from '../pages/Org';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed', 'item.created'] } };
    if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
    if (url.startsWith('/v1/users')) return { data: [{ user_key: 'bob@acme.com', last_seen: '2026-09-29T00:00:00Z', events_count: 12 }] };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    return { data: {} };
  });
  try { window.localStorage.clear(); } catch { /* blocked */ }
});
afterEach(() => { cleanup(); });

const renderAt = (entry: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/" element={<OrgPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const lastCall = (prefix: string) => {
  const hit = [...get.mock.calls].reverse().map(c => String(c[0])).find(u => u.startsWith(prefix));
  return new URLSearchParams((hit ?? '').split('?')[1] ?? '');
};

describe('Org Users panel follows the Event type filter', () => {
  it('asks for the selected event types', async () => {
    renderAt('/?types=item.closed');
    await screen.findByText('bob@acme.com');
    expect(lastCall('/v1/users').get('types')).toBe('item.closed');
  });

  it('re-asks when the selection changes', async () => {
    renderAt('/?types=item.closed&filters=1');
    fireEvent.click(await screen.findByRole('button', { name: 'item.created' }));
    await waitFor(() => expect(lastCall('/v1/users').get('types')?.split(',').sort()).toEqual(['item.closed', 'item.created']));
  });

  it('counts every type when none is selected', async () => {
    renderAt('/?types=');
    await screen.findByText('bob@acme.com');
    expect(lastCall('/v1/users').has('types')).toBe(false);
  });

  it('keeps the tiles across every event type, and says so', async () => {
    renderAt('/?types=item.closed');
    expect(await screen.findByText(/except event type/i)).toBeInTheDocument();
    await waitFor(() => expect(get.mock.calls.some(c => String(c[0]).startsWith('/v1/metrics'))).toBe(true));
    expect(lastCall('/v1/metrics').has('types')).toBe(false);
  });

  it('labels the counts as matching the selected types', async () => {
    renderAt('/?types=item.closed');
    expect(await screen.findByText('1 with matching events')).toBeInTheDocument();
    expect(screen.getByText(/12 matching events · last match/)).toBeInTheDocument();
  });

  it('keeps the plain labels when no type is selected', async () => {
    renderAt('/?types=');
    expect(await screen.findByText('1 reporting')).toBeInTheDocument();
    expect(screen.getByText(/12 events · last /)).toBeInTheDocument();
  });

  it('names no filter the tiles do apply as excluded', async () => {
    renderAt('/?types=item.closed&childHubId=h1');
    expect(await screen.findByText(/every filter except event type/i)).toBeInTheDocument();
  });
});
