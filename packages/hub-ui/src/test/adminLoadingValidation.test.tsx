/**
 * @vitest-environment jsdom
 *
 * [UX] Consistent admin loading and field validation: Sign-in and JIRA sat
 * on "Loading…" forever after a failed request; the keys, users and flows
 * lists said "No … yet" while still fetching; the invite form's email and
 * 8-character password rules lived only in placeholders; the address change
 * accepted any text; the upgrade conflict list collapsed onto one line.
 */
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAuth, AdminKeys, AdminUsers } from '../pages/Admin';
import { AdminJira } from '../pages/AdminJira';
import { AdminFlows } from '../pages/AdminFlows';
import { AdminRepoint } from '../pages/AdminRepoint';
import { inviteErrors, addressChangeError } from '../pages/adminValidation';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const boom = (msg: string) => Object.assign(new Error('Request failed with status code 500'), { response: { data: { error: msg } } });

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(() => cleanup());

describe('validation rules', () => {
  it('check an invite before it is sent', () => {
    expect(inviteErrors({ email: 'alice@acme.com', password: 'longenough', authMethod: 'password' })).toEqual({});
    expect(inviteErrors({ email: 'alice', password: 'longenough', authMethod: 'password' }).email).toMatch(/email address/i);
    expect(inviteErrors({ email: 'alice@acme.com', password: 'short', authMethod: 'password' }).password).toMatch(/8 characters/);
    expect(inviteErrors({ email: 'alice@acme.com', password: '', authMethod: 'sso' })).toEqual({});
  });

  it('check an address change is an https URL', () => {
    expect(addressChangeError('https://hub.new.dev')).toBeNull();
    expect(addressChangeError('http://hub.new.dev')).toMatch(/https:\/\//);
    expect(addressChangeError('hub.new.dev')).toMatch(/https:\/\//);
    expect(addressChangeError('')).toBeNull(); // nothing typed yet is not an error
  });
});

describe('a failed load says so, with a way to retry', () => {
  it('on Sign-in', async () => {
    get.mockRejectedValueOnce(boom('auth store unavailable')).mockResolvedValue({ data: {
      passwordEnabled: true, googleEnabled: false, entraEnabled: false,
      google: { clientId: '', clientSecretSet: false }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: [],
    } });
    mount(<AdminAuth />);
    expect(await screen.findByText('auth store unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Email + password' })).toBeInTheDocument();
  });

  it('on JIRA', async () => {
    get.mockRejectedValue(boom('jira app unreadable'));
    mount(<AdminJira />);
    expect(await screen.findByText('jira app unreadable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('on the API keys list, instead of "No keys yet"', async () => {
    get.mockRejectedValue(boom('keys table locked'));
    mount(<AdminKeys />);
    expect(await screen.findByText('keys table locked')).toBeInTheDocument();
    expect(screen.queryByText('No keys yet.')).toBeNull();
  });

  it('on the users list, instead of "No users yet"', async () => {
    get.mockRejectedValue(boom('users table locked'));
    mount(<AdminUsers />);
    expect(await screen.findByText('users table locked')).toBeInTheDocument();
    expect(screen.queryByText('No users yet.')).toBeNull();
  });
});

describe('an empty list is only claimed once it has loaded', () => {
  for (const [name, el, empty] of [
    ['API keys', <AdminKeys />, 'No keys yet.'],
    ['users', <AdminUsers />, 'No users yet.'],
    ['flows', <AdminFlows />, /No flows yet/],
  ] as const) {
    it(`${name} say they are loading while they fetch`, async () => {
      get.mockReturnValue(new Promise(() => {}));
      mount(el);
      expect(await screen.findByText('Loading…', { selector: '[role="status"]' })).toBeInTheDocument();
      expect(screen.queryByText(empty)).toBeNull();
    });
  }
});

describe('fields say what is wrong before anything is sent', () => {
  it('the user invite', async () => {
    get.mockResolvedValue({ data: [] });
    mount(<AdminUsers />);
    const email = await screen.findByPlaceholderText('alice@acme.com');
    fireEvent.change(email, { target: { value: 'alice' } });
    expect(screen.queryByText(/valid email address/i)).toBeNull(); // not while still typing
    fireEvent.blur(email);
    const pw = screen.getByPlaceholderText(/8 characters/);
    fireEvent.change(pw, { target: { value: 'short' } });
    fireEvent.blur(pw);
    expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^(invite|add)/i })).toBeDisabled();
  });

  it('the address change', async () => {
    get.mockResolvedValue({ data: { campaign: null, counts: {}, drained: true, targets: [] } });
    mount(<AdminRepoint />);
    const url = await screen.findByPlaceholderText('https://hub.new-domain.com');
    fireEvent.change(url, { target: { value: 'hub.new.dev' } });
    fireEvent.blur(url);
    expect(screen.getByText(/https:\/\//, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start the address change' })).toBeDisabled();
  });

  it('lets a valid invite through, trimmed, for password and for SSO', async () => {
    get.mockResolvedValue({ data: [] });
    post.mockResolvedValue({ data: {} });
    mount(<AdminUsers />);
    fireEvent.change(await screen.findByPlaceholderText('alice@acme.com'), { target: { value: ' alice@acme.com ' } });
    fireEvent.change(screen.getByPlaceholderText(/8 characters/), { target: { value: 'longenough' } });
    const invite = screen.getByRole('button', { name: /^invite user$/i });
    expect(invite).toBeEnabled();
    fireEvent.click(invite);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/users/invite', { email: 'alice@acme.com', role: 'viewer', password: 'longenough' }));

    post.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^sso only$/i }));
    fireEvent.change(screen.getByPlaceholderText('alice@acme.com'), { target: { value: 'bob@acme.com' } });
    expect(screen.getByRole('button', { name: /^invite user$/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^invite user$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/users/invite', { email: 'bob@acme.com', role: 'viewer' }));
  });
});

describe('a failed background refresh keeps the loaded form', () => {
  it('on Sign-in: the form stays, with the error above it', async () => {
    const cfg = { passwordEnabled: true, googleEnabled: false, entraEnabled: false,
      google: { clientId: '', clientSecretSet: false }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: [] };
    get.mockResolvedValueOnce({ data: cfg }).mockRejectedValue(boom('hub restarting'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><AdminAuth /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'Email + password' })).toBeInTheDocument();
    await act(async () => { await qc.refetchQueries({ queryKey: ['auth-config'] }); });
    expect(await screen.findByText('hub restarting')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Email + password' })).toBeInTheDocument();
  });
});
