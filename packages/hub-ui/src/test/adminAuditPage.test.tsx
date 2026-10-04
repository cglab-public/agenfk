/**
 * @vitest-environment jsdom
 *
 * STORY a89af514 (task 3/3) — Admin → Audit log: who changed what, when.
 * Newest first, filtered by area, actor and date (sent to the hub, which
 * filters), each row opening on what changed, more rows on request, and the
 * filtered view as CSV. Nothing is hover-only: the expand control is a button.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAudit } from '../pages/AdminAudit';
import { ADMIN_GROUPS } from '../pages/adminSections';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', at: '2026-10-02T10:00:00.000Z', actorUserId: 'u1', actorEmail: 'ana@x', source: 'board', ip: '10.0.0.1',
  area: 'flows', action: 'flow.update', target: 'flow f-1', before: { label: 'Build' }, after: { label: 'Implement' }, link: null, ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/audit']}>
        <Routes><Route path="/admin/audit" element={<AdminAudit />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const lastParams = () => get.mock.calls[get.mock.calls.length - 1][1]?.params ?? {};

beforeEach(() => { get.mockReset(); });
afterEach(cleanup);

describe('Admin → Audit log', () => {
  it('is a section of the Hub group', () => {
    const hub = ADMIN_GROUPS.find(g => g.id === 'hub')!;
    expect(hub.sections.map(s => s.to)).toContain('audit');
  });

  it('lists the rows the hub returns, newest first as given, with who, when, where from and what', async () => {
    get.mockResolvedValue({ data: { rows: [row(), row({ id: 'r2', action: 'auth-config.update', area: 'sign-in', actorEmail: 'bo@x', source: 'cli' })], next: null } });
    mount();
    const items = await screen.findAllByTestId('audit-row');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('ana@x');
    expect(items[0]).toHaveTextContent('flow.update');
    expect(items[0]).toHaveTextContent('flow f-1');
    expect(items[0].querySelector('time')).toHaveAttribute('dateTime', '2026-10-02T10:00:00.000Z');
    expect(items[1]).toHaveTextContent('bo@x');
    expect(items[1]).toHaveTextContent(/cli/i);
    expect(get).toHaveBeenCalledWith('/v1/admin/audit', expect.anything());
  });

  it('opens a row on what changed, before -> after, with a real button', async () => {
    get.mockResolvedValue({ data: { rows: [row()], next: null } });
    mount();
    const item = await screen.findByTestId('audit-row');
    const toggle = within(item).getByRole('button', { name: /show changes/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const diff = within(item).getByTestId('audit-diff');
    expect(diff).toHaveTextContent('label');
    expect(diff).toHaveTextContent('Build');
    expect(diff).toHaveTextContent('Implement');
  });

  it('sends the filters to the hub', async () => {
    get.mockResolvedValue({ data: { rows: [], next: null } });
    mount();
    await waitFor(() => expect(get).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'sign-in' } });
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'ana' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } });
    // The viewer's own days (BUG 91d2941d): the list shows local times, so the bounds are local midnights, sent as instants.
    await waitFor(() => expect(lastParams()).toMatchObject({
      area: 'sign-in', actor: 'ana',
      from: new Date(2026, 8, 1, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 9, 1, 23, 59, 59, 999).toISOString(),
    }));
  });

  it('exports the filtered view as CSV', async () => {
    get.mockResolvedValue({ data: { rows: [], next: null } });
    mount();
    fireEvent.change(await screen.findByLabelText('Area'), { target: { value: 'flows' } });
    const link = screen.getByRole('link', { name: /export csv/i });
    expect(link.getAttribute('href')).toBe('/v1/admin/audit.csv?area=flows');
    expect(link).toHaveAttribute('download');
  });

  it('loads more rows from the cursor', async () => {
    get.mockResolvedValueOnce({ data: { rows: [row()], next: 'CUR1' } });
    get.mockResolvedValueOnce({ data: { rows: [row({ id: 'r9', action: 'flow.create' })], next: null } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getAllByTestId('audit-row')).toHaveLength(2));
    expect(lastParams()).toMatchObject({ cursor: 'CUR1' });
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('says so when nothing matches', async () => {
    get.mockResolvedValue({ data: { rows: [], next: null } });
    mount();
    expect(await screen.findByText(/no changes recorded/i)).toBeInTheDocument();
  });

  it('links a row to the older trail it belongs with', async () => {
    get.mockResolvedValue({ data: { rows: [row({ link: '/admin/models', area: 'models' })], next: null } });
    mount();
    const item = await screen.findByTestId('audit-row');
    expect(within(item).getByRole('link', { name: /open/i })).toHaveAttribute('href', '/admin/models');
  });
});
