/**
 * @vitest-environment jsdom
 *
 * [UX] Admin information architecture: the eleven admin sections are grouped
 * into four areas (People, Access, Fleet, Hub), shown as a rail on wide
 * screens and a select on narrow ones, and /admin lands on an overview with
 * health counts instead of the Auth form.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminLayout } from '../pages/Admin';
import { AdminOverview } from '../pages/AdminOverview';
import { ADMIN_GROUPS } from '../pages/adminSections';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

// Every section App.tsx mounts under /admin.
const ROUTES = ['auth', 'keys', 'users', 'flows', 'upgrades', 'installations', 'repoint', 'identities', 'models', 'jira', 'org', 'audit'];

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const DATA: Record<string, unknown> = {
  '/v1/admin/users': [
    { id: 'u1', email: 'a@acme.dev', provider: 'password', role: 'admin', active: 1, created_at: daysAgo(40), last_login_at: daysAgo(1) },
    { id: 'u2', email: 'b@acme.dev', provider: 'google', role: 'viewer', active: 1, created_at: daysAgo(40), last_login_at: null },
    { id: 'u3', email: 'c@acme.dev', provider: 'google', role: 'viewer', active: 1, created_at: daysAgo(40), last_login_at: null },
    { id: 'u4', email: 'd@acme.dev', provider: 'google', role: 'admin', active: 0, created_at: daysAgo(40), last_login_at: null },
  ],
  '/v1/admin/installations': [
    { id: 'i1', agenfkVersion: '2.0.0', lastSeen: daysAgo(1), firstSeen: daysAgo(30), osUser: 'a', gitName: 'A', gitEmail: 'a@acme.dev', agenfkVersionUpdatedAt: null },
    { id: 'i2', agenfkVersion: '1.9.0', lastSeen: daysAgo(20), firstSeen: daysAgo(30), osUser: 'b', gitName: 'B', gitEmail: 'b@acme.dev', agenfkVersionUpdatedAt: null },
    { id: 'i3', agenfkVersion: '2.0.0', lastSeen: daysAgo(2), firstSeen: daysAgo(30), osUser: 'c', gitName: 'C', gitEmail: 'c@acme.dev', agenfkVersionUpdatedAt: null },
  ],
  '/v1/admin/api-keys': [
    { tokenHashPreview: 'aa', label: 'ci', createdAt: daysAgo(5), revokedAt: null },
    { tokenHashPreview: 'bb', label: 'old', createdAt: daysAgo(50), revokedAt: daysAgo(10) },
    { tokenHashPreview: 'cc', label: 'dev', createdAt: daysAgo(3), revokedAt: null },
  ],
  '/v1/admin/auth-config': {
    passwordEnabled: true, googleEnabled: true, entraEnabled: false,
    google: { clientId: 'x', clientSecretSet: true }, entra: { tenantId: '', clientId: '', clientSecretSet: false }, emailAllowlist: [],
  },
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

const mount = (entry = '/admin') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin" element={<><AdminLayout /><Where /></>}>
            <Route index element={<AdminOverview />} />
            {ROUTES.map(r => <Route key={r} path={r} element={<div>{r} section</div>} />)}
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url in DATA) return { data: DATA[url] };
    throw new Error(`unexpected GET ${url}`);
  });
});
afterEach(() => cleanup());

describe('admin sections', () => {
  it('group every admin route exactly once, in four areas', () => {
    expect(ADMIN_GROUPS.map(g => g.label)).toEqual(['People', 'Access', 'Fleet', 'Hub']);
    const paths = ADMIN_GROUPS.flatMap(g => g.sections.map(s => s.to));
    expect([...paths].sort()).toEqual([...ROUTES].sort());
  });
});

describe('admin navigation', () => {
  it('shows the four areas with their sections in plain words', () => {
    mount('/admin/users');
    const rail = screen.getByRole('navigation', { name: 'Admin sections' });
    for (const area of ['People', 'Access', 'Fleet', 'Hub']) expect(within(rail).getByText(area)).toBeInTheDocument();
    const people = within(rail).getByRole('group', { name: 'People' });
    expect(within(people).getAllByRole('link').map(a => a.textContent?.trim())).toEqual(['Users', 'Identities', 'Installations']);
    expect(within(rail).getByRole('link', { name: 'Sign-in' })).toHaveAttribute('href', '/admin/auth');
    expect(within(rail).getByRole('link', { name: 'Address change' })).toHaveAttribute('href', '/admin/repoint');
    expect(within(rail).getByRole('link', { name: 'API keys & invites' })).toHaveAttribute('href', '/admin/keys');
  });

  it('marks the section you are on', () => {
    mount('/admin/installations');
    const rail = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(rail).getByRole('link', { name: 'Installations' })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('link', { name: 'Users' })).not.toHaveAttribute('aria-current');
    expect(within(rail).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('marks Overview current only on the overview itself', () => {
    mount('/admin');
    const rail = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(rail).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers the same sections as a select on narrow screens, and it navigates', () => {
    mount('/admin/users');
    const select = screen.getByRole('combobox', { name: 'Admin section' }) as HTMLSelectElement;
    expect(select.value).toBe('users');
    expect(within(select).getAllByRole('option')).toHaveLength(ROUTES.length + 1); // + Overview
    fireEvent.change(select, { target: { value: 'flows' } });
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/flows');
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/admin$/);
  });
});

describe('admin overview', () => {
  it('is where /admin lands, not the sign-in form', async () => {
    mount('/admin');
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByText('auth section')).toBeNull();
  });

  it('gives each area health counts that link into it', async () => {
    mount('/admin');
    const people = await screen.findByRole('region', { name: 'People' });
    expect(await within(people).findByText('3 active users · 1 admin')).toBeInTheDocument();
    expect(within(people).getByText('3 installations · 1 silent for 14+ days')).toBeInTheDocument();
    expect(within(people).getByRole('link', { name: 'Installations' })).toHaveAttribute('href', '/admin/installations');

    const access = screen.getByRole('region', { name: 'Access' });
    expect(await within(access).findByText('Sign-in: Password, Google')).toBeInTheDocument();
    expect(within(access).getByText('2 active API keys')).toBeInTheDocument();

    for (const area of ['Fleet', 'Hub']) {
      const region = screen.getByRole('region', { name: area });
      const group = ADMIN_GROUPS.find(g => g.label === area)!;
      for (const s of group.sections) expect(within(region).getByRole('link', { name: s.label })).toHaveAttribute('href', `/admin/${s.to}`);
    }
  });

  it('shows a dash rather than a wrong number when a count cannot load', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/v1/admin/users') throw new Error('boom');
      if (url in DATA) return { data: DATA[url] };
      throw new Error(`unexpected GET ${url}`);
    });
    mount('/admin');
    const people = await screen.findByRole('region', { name: 'People' });
    expect(await within(people).findByText('Users: —')).toBeInTheDocument();
  });
});
