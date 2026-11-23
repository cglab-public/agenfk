/**
 * @vitest-environment jsdom
 *
 * Phase 0 of the Hub auto-join epic (INFRA-463). A row bound to one sign-in
 * identity is never rebound by email, so the Users table gives the admin the
 * one way to move it: reset the user's sign-in link.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminUsers } from '../pages/Admin';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { answerConfirm, forbidWindowConfirm, letMutationsLand } from './helpers/confirmDialog';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const USERS = [
  { id: 'me', email: 'admin@acme.com', provider: 'password', role: 'admin', active: 1, created_at: '2026-01-01', last_login_at: null },
  { id: 'u-sso', email: 'bob@acme.com', provider: 'google', role: 'viewer', active: 1, created_at: '2026-01-01', last_login_at: null },
];
const table: Record<string, unknown> = { '/auth/me': { userId: 'me' }, '/v1/admin/users': USERS };

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter><AdminUsers /></MemoryRouter></QueryClientProvider></ThemeProvider>);
};

beforeEach(() => {
  for (const f of [api.get, api.post, api.put, api.delete]) fn(f).mockReset();
  for (const f of [api.post, api.put, api.delete]) fn(f).mockResolvedValue({ data: {} });
  fn(api.get).mockImplementation(async (url: string) => ({ data: url in table ? table[url] : [] }));
  forbidWindowConfirm();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Reset sign-in in the Users table', () => {
  it('offers it for a user bound to a single sign-on provider, not for a password account', async () => {
    mount();
    const sso = (await screen.findByText('bob@acme.com')).closest('tr') as HTMLElement;
    expect(within(sso).getByRole('button', { name: /reset sign-in for bob@acme.com/i })).toBeInTheDocument();
    const pw = screen.getByText('admin@acme.com').closest('tr') as HTMLElement;
    expect(within(pw).queryByRole('button', { name: /reset sign-in/i })).toBeNull();
  });

  it('asks first, then sends resetSignIn for that user', async () => {
    mount();
    const row = (await screen.findByText('bob@acme.com')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /reset sign-in for bob@acme.com/i }));
    const said = await answerConfirm(true);
    expect(said).toMatch(/next sign-in/i);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/v1/admin/users/u-sso', { resetSignIn: true }));
  });

  it('says the next sign-in needs the provider on and the address allowed', async () => {
    mount();
    const row = (await screen.findByText('bob@acme.com')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /reset sign-in for bob@acme.com/i }));
    const said = await answerConfirm(false);
    expect(said).toMatch(/provider is switched on/i);
    expect(said).toMatch(/allowlist/i);
  });

  it('sends nothing when the admin cancels', async () => {
    mount();
    const row = (await screen.findByText('bob@acme.com')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /reset sign-in for bob@acme.com/i }));
    await answerConfirm(false);
    await letMutationsLand();
    expect(api.put).not.toHaveBeenCalled();
  });
});
