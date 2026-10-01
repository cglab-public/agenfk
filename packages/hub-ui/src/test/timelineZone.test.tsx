/**
 * @vitest-environment jsdom
 *
 * The activity timeline asks the hub for buckets in the viewer's IANA zone,
 * not just today's offset (BUG 27ede354).
 */
import { render, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TimelineBar } from '../components/TimelineBar';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); });

describe('TimelineBar', () => {
  it('sends the browser zone with the offset', async () => {
    get.mockResolvedValue({ data: { bucket: 'day', buckets: [] } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><TimelineBar range="30d" /></QueryClientProvider>);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const q = new URLSearchParams(String(get.mock.calls[0][0]).split('?')[1]);
    expect(q.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(q.get('tzOffsetMin')).toBe(String(-new Date().getTimezoneOffset()));
  });
});

describe('TimelineBar without a nameable zone', () => {
  it('sends only the offset, never a made-up UTC zone', async () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: undefined } as any);
    get.mockResolvedValue({ data: { bucket: 'day', buckets: [] } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><TimelineBar range="30d" /></QueryClientProvider>);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const q = new URLSearchParams(String(get.mock.calls[0][0]).split('?')[1]);
    expect(q.has('tz')).toBe(false);
    expect(q.has('tzOffsetMin')).toBe(true);
    spy.mockRestore();
  });
});
