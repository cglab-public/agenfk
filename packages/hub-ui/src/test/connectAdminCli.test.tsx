/**
 * @vitest-environment jsdom
 *
 * CGLAB-702 S1: `agenfk hub admin login` sends the admin to /connect?code=…&kind=admin.
 * That approval grants the terminal ADMIN access as the person approving, so the
 * page must say so (it is not the installation page's "connect a device"), and
 * it must approve through the admin route, not the installation one.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectPage } from '../pages/Connect';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const post = api.post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { post.mockReset(); post.mockResolvedValue({ data: { ok: true } }); });
afterEach(cleanup);

function mount(search: string) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/connect${search}`]}>
        <Routes><Route path="/connect" element={<ConnectPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Connect page, admin CLI sign-in', () => {
  it('says it grants admin access for 12 hours, and approves through the admin route', async () => {
    mount('?code=ABCD-EFGH&kind=admin');
    expect(screen.getByText(/admin access/i)).toBeInTheDocument();
    expect(screen.getByText(/12 hours/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/hub/admin-device/approve', { userCode: 'ABCD-EFGH' });
    expect(await screen.findByText(/return to your terminal/i)).toBeInTheDocument();
  });

  it('an installation code still approves through the installation route', async () => {
    mount('?code=ABCD-EFGH');
    expect(screen.queryByText(/admin access/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/hub/device/approve', { userCode: 'ABCD-EFGH' }));
  });
});
