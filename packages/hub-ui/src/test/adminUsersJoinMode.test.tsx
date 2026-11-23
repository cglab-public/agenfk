/**
 * @vitest-environment jsdom
 *
 * Hub auto-join (INFRA-463, phase 1a). With automatic join on, a person who
 * still passes the Sign-in checks gets an account on their next Google or
 * Entra sign-in, deleted or never invited. The Users page must not promise
 * otherwise: the invite panel and the delete dialog follow the join mode, and
 * say nothing about it while the mode is unknown.
 */
import { render, screen, fireEvent, cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminUsers } from '../pages/Admin';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { answerConfirm, forbidWindowConfirm } from './helpers/confirmDialog';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
configure({ asyncUtilTimeout: 5000 });
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const users = [
  { id: 'me', email: 'me@x', provider: 'password', role: 'admin', active: 1, created_at: '2026-09-01', last_login_at: null },
  { id: 'v', email: 'view@x', provider: 'entra', role: 'viewer', active: 1, created_at: '2026-09-01', last_login_at: null },
];
const authConfig = (joinMode: 'off' | 'auto') => ({
  passwordEnabled: true, googleEnabled: false, entraEnabled: true,
  google: { clientId: '', clientSecretSet: false, hostedDomains: [] },
  entra: { tenantId: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', clientId: 'cid', clientSecretSet: true, requiredRole: joinMode === 'auto' ? 'AgEnFK.Member' : null },
  emailAllowlist: [], joinMode,
});

/** `config` undefined: the hub refuses the Sign-in configuration, so the join mode is unknown. */
const mount = (config?: ReturnType<typeof authConfig>) => {
  get.mockImplementation(async (url: string) => {
    if (url === '/auth/me') return { data: { userId: 'me' } };
    if (url === '/v1/admin/users') return { data: users };
    if (url === '/v1/admin/auth-config') {
      if (config) return { data: config };
      throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { error: 'boom' } } });
    }
    return { data: [] };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter><AdminUsers /></MemoryRouter></QueryClientProvider></ThemeProvider>);
};

/** The invite panel's header text, once the page has what it needs. */
const invitePanel = async () => (await screen.findByRole('heading', { name: /invite user/i })).closest('header')!.textContent ?? '';
const deleteDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /delete view@x/i }));
  return answerConfirm(false);
};

beforeEach(() => {
  for (const f of [api.get, api.post, api.put, api.delete]) (f as unknown as ReturnType<typeof vi.fn>).mockReset();
  forbidWindowConfirm();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Users page under join mode Off', () => {
  it('the invite panel says only invited people sign in', async () => {
    mount(authConfig('off'));
    expect(await screen.findByText(/does not auto-create accounts/i)).toBeInTheDocument();
  });

  it('the delete dialog says the person can no longer sign in', async () => {
    mount(authConfig('off'));
    await screen.findByText(/does not auto-create accounts/i);
    const text = await deleteDialog();
    expect(text).toMatch(/can no longer sign in/i);
    expect(text).toMatch(/cannot be undone/i);
  });

  it('a hub that reports no join mode predates it, and reads as Off', async () => {
    const { joinMode: _none, ...older } = authConfig('off');
    mount(older as ReturnType<typeof authConfig>);
    expect(await screen.findByText(/does not auto-create accounts/i)).toBeInTheDocument();
    expect(await deleteDialog()).toMatch(/can no longer sign in/i);
  });
});

describe('Users page under automatic join', () => {
  it('the invite panel says a first sign-in creates a viewer, and no longer that SSO creates nobody', async () => {
    mount(authConfig('auto'));
    expect(await screen.findByText(/automatic join is on/i)).toBeInTheDocument();
    const text = await invitePanel();
    expect(text).toMatch(/first google or entra sign-in .*creates a viewer/i);
    expect(text).not.toMatch(/does not auto-create|only invited users can sign in/i);
  });

  it('the delete dialog warns that the next sign-in creates a new account and points to Deactivate', async () => {
    mount(authConfig('auto'));
    await screen.findByText(/automatic join is on/i);
    const text = await deleteDialog();
    expect(text).not.toMatch(/can no longer sign in/i);
    expect(text).toMatch(/next google or entra sign-in creates a new account/i);
    expect(text).toMatch(/deactivate/i);
    expect(text).toMatch(/cannot be undone/i);
  });
});

describe('Users page while the join mode is unknown', () => {
  it('promises nothing about sign-in in either place', async () => {
    mount();
    const panel = await invitePanel();
    expect(panel).not.toMatch(/does not auto-create|only invited users can sign in|automatic join is on/i);
    const text = await deleteDialog();
    expect(text).not.toMatch(/can no longer sign in/i);
    expect(text).toMatch(/cannot be undone/i);
  });
});
