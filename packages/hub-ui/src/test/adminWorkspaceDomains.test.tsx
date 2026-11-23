/**
 * @vitest-environment jsdom
 *
 * Phase 0 of the Hub auto-join epic (INFRA-463). The Sign-in page edits the
 * Google Workspace domains the hub checks against the hd claim, and no longer
 * offers the Entra multi-tenant aliases the hub now refuses to save.
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
  passwordEnabled: true, googleEnabled: true, entraEnabled: true,
  google: { clientId: 'gid', clientSecretSet: true, hostedDomains: ['acme.com'] },
  entra: { tenantId: '', clientId: '', clientSecretSet: false },
  emailAllowlist: [],
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

describe('Google Workspace domains on the Sign-in page', () => {
  it('shows the stored domains', async () => {
    mount();
    expect(await screen.findByLabelText(/workspace domains/i)).toHaveValue('acme.com');
  });

  it('saves the edited list as google.hostedDomains', async () => {
    mount();
    const input = await screen.findByLabelText(/workspace domains/i);
    fireEvent.change(input, { target: { value: 'acme.com, sub.acme.com ,' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = fn(api.put).mock.calls[0];
    expect(url).toBe('/v1/admin/auth-config');
    expect(body.google.hostedDomains).toEqual(['acme.com', 'sub.acme.com']);
  });
});

describe('Entra tenant field', () => {
  it('asks for a tenant GUID and no longer suggests common or organizations', async () => {
    mount();
    const tenant = await screen.findByLabelText(/tenant id/i);
    expect(tenant.getAttribute('placeholder') ?? '').not.toMatch(/common|organizations/i);
    expect(tenant.getAttribute('placeholder') ?? '').toMatch(/guid/i);
  });
});

describe('Unreadable stored lists on the Sign-in page', () => {
  it('warns that sign-in is closed instead of showing an empty allowlist', async () => {
    fn(api.get).mockResolvedValue({ data: { ...config, emailAllowlist: [], emailAllowlistUnreadable: true } });
    mount();
    expect(await screen.findByText(/allowlist stored on this hub is unreadable/i)).toBeInTheDocument();
  });

  it('warns the same way for the Workspace domains', async () => {
    fn(api.get).mockResolvedValue({ data: { ...config, google: { ...config.google, hostedDomains: [], hostedDomainsUnreadable: true } } });
    mount();
    expect(await screen.findByText(/workspace domains stored on this hub are unreadable/i)).toBeInTheDocument();
  });
});
