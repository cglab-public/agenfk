/**
 * @vitest-environment jsdom
 *
 * [UX] CopyField and secret handling: copy-to-clipboard was written four
 * times, each swallowing a failure and never resetting "Copied"; values an
 * admin has to paste elsewhere had no copy button; the one-time API token
 * vanished silently on navigation; "✓ Saved" outlived later edits.
 */
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CopyButton } from '../components/ui';
import { AdminKeys, AdminAuth, AdminInstallations } from '../pages/Admin';
import { AdminJira } from '../pages/AdminJira';
import { AdminOrg } from '../pages/AdminOrg';
import { Layout } from '../components/Layout';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const writeText = vi.fn();
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

const REDIRECT = 'https://hub.acme.test/v1/jira/oauth/callback';
const ROUTES: Record<string, unknown> = {
  '/auth/me': { userId: 'u1', orgId: 'acme', role: 'admin', email: 'admin@acme.dev' },
  '/healthz': { ok: true, version: '2.0.0' },
  '/v1/admin/system/pending': { pendingEnvOrgId: 'cglab' },
  '/v1/admin/federation': { bound: false, outboxDepth: 0 },
  '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
  '/v1/admin/api-keys': [],
  '/v1/admin/installations': [{ id: '3f0c1a2b-1111-4222-8333-944445555666', agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: null, firstSeen: null, lastSeen: new Date().toISOString(), osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@acme.dev' }],
  '/v1/admin/hidden-users': [],
  '/v1/admin/jira': { configured: true, clientId: 'cid-1', clientSecretSet: true, connectedCount: 0, redirectUri: REDIRECT },
  '/v1/admin/auth-config': { passwordEnabled: true, googleEnabled: false, entraEnabled: false, google: { clientId: '', clientSecretSet: false }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: [] },
};

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
};

beforeEach(() => {
  writeText.mockReset(); writeText.mockResolvedValue(undefined);
  get.mockReset(); put.mockReset(); post.mockReset();
  get.mockImplementation(async (url: string) => {
    const key = Object.keys(ROUTES).find(k => url.startsWith(k));
    return { data: key ? ROUTES[key] : [] };
  });
  put.mockImplementation(async (_url: string, body: unknown) => ({ data: { ...(ROUTES['/v1/admin/jira'] as object), ...(body as object) } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('CopyButton', () => {
  it('copies the value, says so, and goes back to its label', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CopyButton value="secret-123" label="Copy token" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(writeText).toHaveBeenCalledWith('secret-123');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(screen.getByRole('button', { name: 'Copy token' })).toBeInTheDocument();
  });

  it('says so when the clipboard refuses, instead of failing silently', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyButton value="secret-123" label="Copy token" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/couldn.t copy/i);
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });
});

describe('values an admin has to paste elsewhere can be copied', () => {
  it('the JIRA callback URL', async () => {
    mount(<AdminJira />);
    await screen.findByText(REDIRECT);
    fireEvent.click(screen.getByRole('button', { name: 'Copy callback URL' }));
    expect(writeText).toHaveBeenCalledWith(REDIRECT);
  });

  it('an installation id', async () => {
    mount(<AdminInstallations />);
    await screen.findByText('Carol Diaz');
    fireEvent.click(screen.getByRole('button', { name: 'Copy installation id for Carol Diaz' }));
    expect(writeText).toHaveBeenCalledWith('3f0c1a2b-1111-4222-8333-944445555666');
  });
});

describe('the copies that moved to the shared button still copy the right value', () => {
  it('an invite join command', async () => {
    post.mockResolvedValue({ data: { joinCommand: 'agenfk hub join tok-9', expiresAt: '2026-10-01T00:00:00Z' } });
    mount(<AdminKeys />);
    fireEvent.click(screen.getByRole('button', { name: /generate invite/i }));
    await screen.findByText('agenfk hub join tok-9');
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    expect(writeText).toHaveBeenCalledWith('agenfk hub join tok-9');
  });

  it('the repoint command after an org rename', async () => {
    post.mockResolvedValue({ data: { orgId: 'cglab', from: 'acme', to: 'cglab' } });
    mount(<AdminOrg />);
    fireEvent.change(await screen.findByPlaceholderText(/new org id/i), { target: { value: 'cglab' } });
    fireEvent.click(await screen.findByRole('button', { name: /^rename$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename to cglab' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    expect(String(writeText.mock.calls[0]?.[0])).toMatch(/^agenfk hub repoint --url \S+ --org-id cglab --carry-over$/);
  });

  it('the AGENFK_HUB_ORG_ID setting in the banner', async () => {
    mount(<ThemeProvider><Layout><div>content</div></Layout></ThemeProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy setting' }));
    expect(writeText).toHaveBeenCalledWith('AGENFK_HUB_ORG_ID=cglab');
  });
});

describe('the one-time API token', () => {
  const leaveEvent = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e;
  };

  it('asks before the page is left while the token is still showing', async () => {
    post.mockResolvedValue({ data: { token: 'agk_live_123' } });
    mount(<AdminKeys />);
    fireEvent.change(screen.getByPlaceholderText(/label/i), { target: { value: 'laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));
    expect(await screen.findByText('agk_live_123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('agk_live_123');
    expect(leaveEvent().defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    expect(leaveEvent().defaultPrevented).toBe(false);
  });
});

describe('"Saved" does not outlive the next edit', () => {
  it('on the JIRA app form', async () => {
    mount(<AdminJira />);
    const id = await screen.findByDisplayValue('cid-1');
    fireEvent.change(id, { target: { value: 'cid-2' } });
    fireEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText('✓ Saved')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('cid-2'), { target: { value: 'cid-3' } });
    expect(screen.queryByText('✓ Saved')).toBeNull();
  });

  it('on the sign-in form', async () => {
    put.mockResolvedValue({ data: {} });
    mount(<AdminAuth />);
    await screen.findByText(/Microsoft Entra/i);
    fireEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeInTheDocument());
    // Any edit counts; switching a provider on is one (its fields are hidden while off).
    fireEvent.click(screen.getByRole('switch', { name: 'Microsoft Entra sign-in' }));
    expect(screen.queryByText('✓ Saved')).toBeNull();
  });
});
