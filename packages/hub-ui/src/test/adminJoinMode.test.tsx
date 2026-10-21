/**
 * @vitest-environment jsdom
 *
 * Phase 1a of the Hub auto-join epic (INFRA-463). The Sign-in page chooses
 * whether a first SSO sign-in creates the member, and which Entra app role a
 * token must carry for that.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuth } from '../pages/Admin';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const config = {
  passwordEnabled: true, googleEnabled: false, entraEnabled: true,
  google: { clientId: '', clientSecretSet: false, hostedDomains: [] },
  entra: { tenantId: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', clientId: 'cid', clientSecretSet: true, requiredRole: null },
  emailAllowlist: [],
  joinMode: 'off',
};

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter><AdminAuth /></MemoryRouter></QueryClientProvider></ThemeProvider>);
};

beforeEach(() => {
  for (const f of [api.get, api.post, api.put, api.delete]) fn(f).mockReset();
  fn(api.put).mockResolvedValue({ data: {} });
  fn(api.get).mockResolvedValue({ data: config });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Join mode on the Sign-in page', () => {
  it('shows the stored join mode', async () => {
    fn(api.get).mockResolvedValue({ data: { ...config, joinMode: 'auto', entra: { ...config.entra, requiredRole: 'AgEnFK.Member' } } });
    mount();
    expect(await screen.findByLabelText(/join mode/i)).toHaveValue('auto');
    expect(screen.getByLabelText(/required app role/i)).toHaveValue('AgEnFK.Member');
  });

  it('saves automatic join with the required app role', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText(/join mode/i), { target: { value: 'auto' } });
    fireEvent.change(screen.getByLabelText(/required app role/i), { target: { value: 'AgEnFK.Member' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = fn(api.put).mock.calls[0];
    expect(url).toBe('/v1/admin/auth-config');
    expect(body.joinMode).toBe('auto');
    expect(body.entra.requiredRole).toBe('AgEnFK.Member');
  });

  it('warns that Google creates nobody while no Workspace domain is set', async () => {
    fn(api.get).mockResolvedValue({ data: { ...config, googleEnabled: true, joinMode: 'auto', entra: { ...config.entra, requiredRole: 'AgEnFK.Member' } } });
    mount();
    expect(await screen.findByText(/google creates nobody until a workspace domain is set/i)).toBeInTheDocument();
  });

  it('does not warn once a Workspace domain is set', async () => {
    fn(api.get).mockResolvedValue({ data: { ...config, googleEnabled: true, joinMode: 'auto', google: { ...config.google, hostedDomains: ['acme.com'] }, entra: { ...config.entra, requiredRole: 'AgEnFK.Member' } } });
    mount();
    await screen.findByLabelText(/join mode/i);
    expect(screen.queryByText(/google creates nobody/i)).not.toBeInTheDocument();
  });

  it('offers only off and automatic', async () => {
    mount();
    const select = await screen.findByLabelText(/join mode/i);
    const values = Array.from(select.querySelectorAll('option')).map(o => (o as HTMLOptionElement).value);
    expect(values).toEqual(['off', 'auto']);
  });
});
