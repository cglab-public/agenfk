/**
 * @vitest-environment jsdom
 *
 * [UX] Collapse disabled sign-in providers: Google and Microsoft Entra were
 * off, yet their client ID and secret fields sat fully expanded. A provider's
 * fields now show only while it is switched on, and its card says whether it
 * is on, off, or on without the credentials it needs.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuth } from '../pages/Admin';
import { providerStatus } from '../pages/signInProviderStatus';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

let config: Record<string, unknown>;
const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AdminAuth /></MemoryRouter></QueryClientProvider>);
};
const card = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;

beforeEach(() => {
  config = {
    passwordEnabled: true, googleEnabled: true, entraEnabled: false,
    google: { clientId: 'x.apps.googleusercontent.com', clientSecretSet: true },
    entra: { tenantId: '', clientId: '', clientSecretSet: false },
    emailAllowlist: [],
  };
  get.mockReset();
  get.mockImplementation(async () => ({ data: config }));
});
afterEach(() => cleanup());

describe('providerStatus', () => {
  const req = (...present: boolean[]) => ['a tenant ID', 'a client ID', 'a client secret'].map((label, i) => ({ label, present: present[i] }));
  it('is off, on, or on with what is missing named', () => {
    expect(providerStatus({ enabled: false, requires: req(false, false, false) })).toEqual({ label: 'Off', tone: 'neutral' });
    expect(providerStatus({ enabled: true, requires: req(true, true, true) })).toEqual({ label: 'On', tone: 'ok' });
    expect(providerStatus({ enabled: true, requires: req(false, true, true) })).toEqual({ label: 'On · needs a tenant ID', tone: 'warn' });
    expect(providerStatus({ enabled: true, requires: req(true, false, false) })).toEqual({ label: 'On · needs a client ID and a client secret', tone: 'warn' });
    expect(providerStatus({ enabled: true, requires: req(false, false, false) })).toEqual({ label: 'On · needs a tenant ID, a client ID and a client secret', tone: 'warn' });
  });
});

describe('sign-in provider cards', () => {
  it('hide an off provider\'s fields and say it is off', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Microsoft Entra' });
    const entra = card('Microsoft Entra');
    expect(within(entra).getByText('Off')).toBeInTheDocument();
    expect(within(entra).queryByPlaceholderText('common, organizations, or tenant GUID')).toBeNull();
    expect(within(entra).queryByPlaceholderText('application (client) ID')).toBeNull();
  });

  it('show an on provider\'s fields and say it is on', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Google' });
    const google = card('Google');
    expect(within(google).getByText('On')).toBeInTheDocument();
    expect(within(google).getByDisplayValue('x.apps.googleusercontent.com')).toBeInTheDocument();
  });

  it('open the fields when a provider is switched on, and warn until it has credentials', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Microsoft Entra' });
    fireEvent.click(screen.getByRole('switch', { name: 'Microsoft Entra sign-in' }));
    const entra = card('Microsoft Entra');
    expect(within(entra).getByPlaceholderText('common, organizations, or tenant GUID')).toBeInTheDocument();
    expect(within(entra).getByText('On · needs a tenant ID, a client ID and a client secret')).toBeInTheDocument();
  });

  it('keep what was typed when a provider is switched off and back on', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Google' });
    const sw = screen.getByRole('switch', { name: 'Google sign-in' });
    fireEvent.change(screen.getByDisplayValue('x.apps.googleusercontent.com'), { target: { value: 'y.apps.googleusercontent.com' } });
    fireEvent.change(screen.getByPlaceholderText('•••••• (leave blank to keep)'), { target: { value: 'new-secret' } });
    fireEvent.click(sw);
    expect(within(card('Google')).queryByDisplayValue('y.apps.googleusercontent.com')).toBeNull();
    fireEvent.click(sw);
    expect(within(card('Google')).getByDisplayValue('y.apps.googleusercontent.com')).toBeInTheDocument();
    expect(within(card('Google')).getByDisplayValue('new-secret')).toBeInTheDocument();
  });

  it('say On once a fresh provider has everything it needs, a typed secret included', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Microsoft Entra' });
    fireEvent.click(screen.getByRole('switch', { name: 'Microsoft Entra sign-in' }));
    const entra = card('Microsoft Entra');
    fireEvent.change(within(entra).getByPlaceholderText('common, organizations, or tenant GUID'), { target: { value: 'organizations' } });
    fireEvent.change(within(entra).getByPlaceholderText('application (client) ID'), { target: { value: 'app-1' } });
    expect(within(entra).getByText('On · needs a client secret')).toBeInTheDocument();
    fireEvent.change(within(entra).getByPlaceholderText('client secret value'), { target: { value: 's3cret' } });
    expect(within(entra).getByText('On')).toBeInTheDocument();
  });
});
