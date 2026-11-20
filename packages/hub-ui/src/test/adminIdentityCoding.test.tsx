/**
 * @vitest-environment jsdom
 *
 * Admin → Organization → Identities forwarded to this hub (GH-395). Two fields, the
 * person and the installation, each sent as written or coded: a group default
 * and an optional override per child hub. What a unit test cannot see:
 *  - each field says plainly what coding it does, and that everything else
 *    (model, harness, steps, repository, ticket) is always sent as written;
 *  - a change sends only the field that changed;
 *  - a change that sends MORE (as written, or back to the group's) is
 *    confirmed first, because what the parent already has cannot be taken back;
 *  - each child shows its own setting and the one actually in force.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminIdentityCoding } from '../pages/AdminIdentityCoding';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;

const DATA = {
  group: { person: 'coded', installation: null },
  effective: { person: 'coded', installation: 'as-written' },
  childHubs: [
    { id: 'ch-1', name: 'acme-emea', override: { person: null, installation: null }, effective: { person: 'coded', installation: 'as-written' } },
    { id: 'ch-2', name: 'acme-latam', override: { person: 'as-written', installation: 'coded' }, effective: { person: 'as-written', installation: 'coded' } },
  ],
};

const renderPage = (data: unknown = DATA) => {
  get.mockImplementation(async () => ({ data }));
  put.mockImplementation(async () => ({ data: {} }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AdminIdentityCoding /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => { get.mockReset(); put.mockReset(); });
afterEach(() => { cleanup(); get.mockReset(); put.mockReset(); });

describe('Admin → Identities forwarded to this hub', () => {
  it('names both fields and says what coding each one does', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /identities forwarded to this hub/i })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/admin/federation/identity');
    expect(await screen.findByText(/user key, git name, git email and OS user/i)).toBeInTheDocument();
    expect(screen.getByText(/installation id/i)).toBeInTheDocument();
    expect(screen.getByText(/model, harness, step names, repository and ticket are always sent as written/i)).toBeInTheDocument();
  });

  it('shows the group default per field, with an unset field as written', async () => {
    renderPage();
    expect(await screen.findByRole('combobox', { name: 'Group default: Person' })).toHaveValue('coded');
    expect(screen.getByRole('combobox', { name: 'Group default: Installation' })).toHaveValue('as-written');
  });

  it('codes a group field at once, sending only that field', async () => {
    renderPage();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Group default: Installation' }), { target: { value: 'coded' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/federation/identity', { installation: 'coded' }));
  });

  it('asks before sending a group field as written, and sends nothing if cancelled', async () => {
    renderPage();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Group default: Person' }), { target: { value: 'as-written' } });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be taken back/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Group default: Person' }), { target: { value: 'as-written' } });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /send as written/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/federation/identity', { person: 'as-written' }));
  });

  it("lists each child with its own setting per field and the one in force", async () => {
    renderPage();
    const rows = await screen.findAllByRole('row');
    const emea = rows.find(r => r.textContent?.includes('acme-emea'))!;
    expect(within(emea).getByRole('combobox', { name: 'Person for acme-emea' })).toHaveValue('inherit');
    expect(within(emea).getByRole('combobox', { name: 'Installation for acme-emea' })).toHaveValue('inherit');
    expect(within(emea).getByText(/person coded, installation as written/i)).toBeInTheDocument();
    const latam = rows.find(r => r.textContent?.includes('acme-latam'))!;
    expect(within(latam).getByRole('combobox', { name: 'Person for acme-latam' })).toHaveValue('as-written');
    expect(within(latam).getByRole('combobox', { name: 'Installation for acme-latam' })).toHaveValue('coded');
  });

  it('overrides one field for one child, and confirms before following the group again', async () => {
    renderPage();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Person for acme-latam' }), { target: { value: 'coded' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/child-hubs/ch-2/identity', { person: 'coded' }));
    put.mockClear();

    fireEvent.change(screen.getByRole('combobox', { name: 'Installation for acme-latam' }), { target: { value: 'inherit' } });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /send as written|follow the group/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/child-hubs/ch-2/identity', { installation: null }));
  });

  it('says so when the settings cannot be loaded', async () => {
    get.mockImplementation(async () => { throw new Error('boom'); });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><AdminIdentityCoding /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i);
  });
});
