/**
 * @vitest-environment jsdom
 *
 * [UX] Admin safety: an admin could lock everyone out. The role select and
 * Active switch worked on your own row, and Sign-in saved with every method
 * switched off. The server refuses both; the UI stops offering them, and says
 * why, instead of letting a click fail.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuth, AdminUsers } from '../pages/Admin';
import { userAccessLock, isLastActiveAdmin } from '../pages/userAccessLock';
import { noWorkingSignInMethod } from '../pages/signInProviderStatus';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
};

const user = (id: string, email: string, role: 'admin' | 'viewer', active = 1) =>
  ({ id, email, provider: 'password', role, active, created_at: '2026-09-01T00:00:00Z', last_login_at: null });

beforeEach(() => { get.mockReset(); put.mockReset(); });
afterEach(() => cleanup());

describe('userAccessLock', () => {
  const me = user('me', 'me@x', 'admin');
  const other = user('o', 'other@x', 'admin');
  const viewer = user('v', 'view@x', 'viewer');

  it('locks your own row', () => {
    expect(userAccessLock(me, 'me', [me, other, viewer])).toMatch(/your own/i);
  });

  it('locks the last active admin', () => {
    // Reachable when the signed-in session is not itself an active admin row
    // (a stale session after a demotion): the server refuses it either way.
    expect(userAccessLock(other, 'v', [other, viewer])).toMatch(/last active admin/i);
  });

  it('does not count an inactive admin', () => {
    const off = user('off', 'off@x', 'admin', 0);
    expect(userAccessLock(other, 'v', [other, off, viewer])).toMatch(/last active admin/i);
  });

  it('leaves another admin unlocked while another active admin remains', () => {
    expect(userAccessLock(other, 'me', [me, other, viewer])).toBeNull();
  });

  it('leaves a viewer unlocked', () => {
    expect(userAccessLock(viewer, 'me', [me, other, viewer])).toBeNull();
  });

  it('locks every row until the signed-in user is known', () => {
    expect(userAccessLock(viewer, undefined, [me, viewer])).not.toBeNull();
  });
});

describe('isLastActiveAdmin', () => {
  it('is true only for the one active admin', () => {
    const a = user('a', 'a@x', 'admin');
    const b = user('b', 'b@x', 'admin', 0);
    expect(isLastActiveAdmin(a, [a, b])).toBe(true);
    expect(isLastActiveAdmin(b, [a, b])).toBe(false);
    expect(isLastActiveAdmin(a, [a, user('c', 'c@x', 'admin')])).toBe(false);
  });
});

describe('Users table, signed-in user unknown', () => {
  it('says why every row is locked when /auth/me fails, with a way to retry', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/auth/me') throw Object.assign(new Error('Request failed'), { response: { data: { error: 'session store down' } } });
      return { data: [user('v', 'view@x', 'viewer')] };
    });
    mount(<AdminUsers />);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('Users table, last active admin', () => {
  it('offers no Delete on the last active admin', async () => {
    // A stale session: the signed-in viewer still holds an admin cookie.
    get.mockImplementation(async (url: string) => {
      if (url === '/auth/me') return { data: { userId: 'v' } };
      if (url === '/v1/admin/users') return { data: [user('a', 'only@x', 'admin'), user('v', 'view@x', 'viewer'), user('w', 'other@x', 'viewer')] };
      return { data: [] };
    });
    mount(<AdminUsers />);
    const only = (await screen.findByText('only@x')).closest('tr') as HTMLElement;
    const other = (await screen.findByText('other@x')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(other).getByRole('button', { name: /delete/i })).toBeInTheDocument());
    expect(within(only).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});

describe('Users table', () => {
  const rows = [user('me', 'me@x', 'admin'), user('v', 'view@x', 'viewer')];
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url === '/auth/me') return { data: { userId: 'me' } };
      if (url === '/v1/admin/users') return { data: rows };
      return { data: [] };
    });
  });

  const row = async (email: string) => (await screen.findByText(email)).closest('tr') as HTMLElement;

  it('disables role and Active on your own row, and says why', async () => {
    mount(<AdminUsers />);
    const mine = await row('me@x');
    await waitFor(() => expect(within(mine).getByRole('combobox')).toBeDisabled());
    expect(within(mine).getByRole('switch')).toBeDisabled();
    expect(within(mine).getByText(/your own/i)).toBeInTheDocument();
  });

  it('keeps role and Active usable on other rows', async () => {
    mount(<AdminUsers />);
    const theirs = await row('view@x');
    await waitFor(() => expect(within(theirs).getByRole('combobox')).toBeEnabled());
    expect(within(theirs).getByRole('switch')).toBeEnabled();
  });

  it('sends no request when the disabled switch on your own row is clicked', async () => {
    mount(<AdminUsers />);
    const mine = await row('me@x');
    await waitFor(() => expect(within(mine).getByRole('switch')).toBeDisabled());
    fireEvent.click(within(mine).getByRole('switch'));
    expect(put).not.toHaveBeenCalled();
  });
});

describe('noWorkingSignInMethod', () => {
  const base = {
    passwordEnabled: true, googleEnabled: false, entraEnabled: false,
    google: { clientId: '', clientSecretSet: false }, entra: { tenantId: '', clientId: '', clientSecretSet: false },
  };

  it('is false while email + password is on', () => {
    expect(noWorkingSignInMethod(base)).toBe(false);
  });

  it('is true with every method off', () => {
    expect(noWorkingSignInMethod({ ...base, passwordEnabled: false })).toBe(true);
  });

  it('is true when the only method on is Google without a client ID', () => {
    expect(noWorkingSignInMethod({ ...base, passwordEnabled: false, googleEnabled: true, google: { clientId: ' ', clientSecretSet: true } })).toBe(true);
  });

  it('counts a secret typed into the form, not only a stored one', () => {
    expect(noWorkingSignInMethod({ ...base, passwordEnabled: false, googleEnabled: true, google: { clientId: 'id', clientSecretSet: false, clientSecret: 'typed' } })).toBe(false);
  });

  it('is true when the only method on is Entra without a tenant', () => {
    expect(noWorkingSignInMethod({ ...base, passwordEnabled: false, entraEnabled: true, entra: { tenantId: '', clientId: 'app', clientSecretSet: true } })).toBe(true);
  });

  it('is false with a complete Entra provider', () => {
    expect(noWorkingSignInMethod({ ...base, passwordEnabled: false, entraEnabled: true, entra: { tenantId: 'common', clientId: 'app', clientSecretSet: true } })).toBe(false);
  });
});

describe('Sign-in form', () => {
  beforeEach(() => {
    get.mockResolvedValue({ data: {
      passwordEnabled: true, googleEnabled: false, entraEnabled: false,
      google: { clientId: '', clientSecretSet: false }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: [],
    } });
  });

  it('blocks Save, and says why, when the change would leave no way to sign in', async () => {
    mount(<AdminAuth />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Email + password sign-in' }));
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/no way to sign in/i);
  });

  it('allows Save again once a working method is back on', async () => {
    mount(<AdminAuth />);
    const pw = await screen.findByRole('switch', { name: 'Email + password sign-in' });
    fireEvent.click(pw);
    fireEvent.click(pw);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    expect(screen.queryByText(/no way to sign in/i)).not.toBeInTheDocument();
  });
});
