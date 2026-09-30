/**
 * @vitest-environment jsdom
 *
 * The dashboards and entry pages render on the visual-system tokens only
 * (CGLAB-434 S3.2). Each page is mounted against a mocked api and its rendered
 * classes checked: no raw Tailwind palette colours, no gradient buttons or glow,
 * none of the old teal-tint selection classes, and teal text only on the brand
 * mark.
 */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../components/Layout';
import { OrgPage } from '../pages/Org';
import { PrOverviewPage } from '../pages/PrOverview';
import { UserDetailPage } from '../pages/UserDetail';
import { LoginPage } from '../pages/Login';
import { SetupPage } from '../pages/Setup';
import { ConnectPage } from '../pages/Connect';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const RAW_PALETTE = /\b(?:bg|text|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|shadow|caret|accent|decoration|placeholder)-(?:(?:red|rose|amber|yellow|orange|emerald|green|teal|cyan|sky|blue|indigo|violet|purple|pink|fuchsia|lime|slate|gray|zinc|neutral|stone)-\d{2,3}|white|black)\b/;
const OLD_ACCENT = /(?:^|\s|:)(?:(?:bg|from|to|via)-chip(?:\/\d+)?|(?:border|outline|ring)-border-brand(?:\/\d+)?|bg-mint(?:\/\d+)?|bg-brand\/\d+|text-brand-dark|text-brand-light|shadow-glow|bg-gradient-[\w-]+|bg-\[image:var\(--gradient-accent\)\]|(?:border|ring|outline)-brand(?:\/\d+)?|ring-brand)(?=\s|$)/;

const OVERVIEW = {
  period: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-22T23:59:59.999Z' },
  buckets: ['xs', 's', 'm', 'l', 'xl'],
  totals: { prs: 3, sizePoints: 12, developers: 1, medianBucket: 's' },
  // count > 0 so the resize strip renders and is checked too.
  resized: { count: 2, grew: 1, shrank: 1 },
  byDay: [{ day: '2026-08-12', sizes: { xs: 1, s: 1, m: 1, l: 0, xl: 0 }, devBySize: {} }],
  byDeveloper: [{ user_key: 'alice@acme.com', prs: 3, sizePoints: 12, sizes: { xs: 1, s: 1, m: 1, l: 0, xl: 0 }, daily: { '2026-08-12': 3 } }],
  byModel: [{ model: 'claude-opus-5', harnesses: ['claude-code'], prs: 3, sizePoints: 12, sizes: { xs: 1, s: 1, m: 1, l: 0, xl: 0 } }],
  prs: [],
  previous: { prs: 2, sizePoints: 8 },
};
const EVENT = (type: string, item_type: string | null) => ({
  event_id: `${type}-${item_type}`, occurred_at: '2026-08-13T10:00:00Z', type, project_id: 'p', item_id: 'i', item_type,
  remote_url: 'https://github.com/acme/api.git', item_title: 'Fix login', external_id: 'CGLAB-1', user_key: 'alice@acme.com',
  reporting_version: '2.0.0', payload: { a: 1 },
});

function mockApi({ role = 'admin' as 'admin' | 'viewer', pendingEnv = null as string | null } = {}) {
  get.mockImplementation(async (url: string) => {
    if (url === '/auth/me') return { data: { userId: 'u1', orgId: 'o', role, email: 'admin@acme.com', name: 'Ada Admin' } };
    if (url === '/healthz') return { data: { ok: true, version: '2.0.0' } };
    if (url === '/auth/providers') return { data: { password: true, google: true, entra: true, requiresSetup: false } };
    if (url.startsWith('/v1/admin/system/pending')) return { data: { pendingEnvOrgId: pendingEnv } };
    if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
    // More than six, so the facet switches to its chip-and-popover mode (chips with a remove button).
    if (url.startsWith('/v1/projects')) return { data: { projects: ['acme/api', 'acme/web', 'acme/ios', 'acme/android', 'acme/infra', 'acme/docs', 'acme/cli'] } };
    if (url.startsWith('/v1/event-types')) return { data: { types: ['item.closed', 'validate.passed', 'validate.failed'] } };
    if (url.startsWith('/v1/item-types')) return { data: { itemTypes: ['TASK', 'BUG'], counts: { TASK: 2, BUG: 1 } } };
    if (url.startsWith('/v1/users')) return { data: [{ user_key: 'alice@acme.com', last_seen: '2026-08-14T00:00:00Z', events_count: 3 }] };
    if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [{ user_key: 'alice@acme.com', day: '2026-08-12', events_count: 9, items_closed: 3, validate_passes: 4, validate_fails: 1, prs_opened: 2 }] } };
    if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
    if (url.startsWith('/v1/prs/overview')) return { data: OVERVIEW };
    if (url.startsWith('/v1/timeline')) return { data: { events: [EVENT('validate.passed', 'TASK'), EVENT('validate.failed', 'BUG'), EVENT('comment.added', 'STORY'), EVENT('item.closed', 'EPIC')] } };
    return { data: {} };
  });
}

function mount(entry: string, path: string, element: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes><Route path={path} element={element} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** Every class in the tree, except on the brand mark itself (the spark and the teal wordmark letters). */
function classesOutsideLogo(root: HTMLElement): string {
  const marks = Array.from(root.querySelectorAll('[data-brand-mark]'));
  return [root, ...Array.from(root.querySelectorAll('*'))]
    .filter(el => !marks.some(m => m.contains(el)))
    .map(el => el.getAttribute('class') ?? '').join(' ');
}

function expectOnTokens(root: HTMLElement) {
  const cls = classesOutsideLogo(root);
  expect(cls.match(RAW_PALETTE)?.[0] ?? null, 'raw palette colour').toBeNull();
  expect(cls.match(OLD_ACCENT)?.[0]?.trim() ?? null, 'old teal accent / gradient / glow').toBeNull();
  // Teal text is the brand mark's alone; everything else uses the indigo ink.
  expect(cls.match(/(?:^|\s|:)text-accent-text(?:\s|$)/)?.[0] ?? null, 'teal text outside the logo').toBeNull();
  // Solid teal belongs to the one primary button, never to decoration.
  const teal = Array.from(root.querySelectorAll('[class]')).filter(el =>
    /(?:^|\s)bg-brand(?:\s|$)/.test(el.getAttribute('class') ?? '') && !el.closest('[data-brand-mark]'));
  for (const el of teal) expect(el.tagName, `bg-brand on <${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 20)}"`).toBe('BUTTON');
}

beforeEach(() => { get.mockReset(); try { window.localStorage.clear(); } catch { /* blocked */ } });
afterEach(() => { cleanup(); get.mockReset(); });

describe('shell', () => {
  it('marks the current page on the indigo accent, announced as current', async () => {
    mockApi();
    mount('/', '/', <Layout><div>content</div></Layout>);
    const link = await screen.findByRole('link', { name: /Org rollup/ });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link.className).toMatch(/(?:^|\s)text-accent-ink(?:\s|$)/);
    expect(screen.getByRole('link', { name: /PR overview/ })).not.toHaveAttribute('aria-current');
  });

  it('shows the pending org-id banner as a warning callout', async () => {
    mockApi({ pendingEnv: 'org-123' });
    mount('/', '/', <Layout><div>content</div></Layout>);
    const word = await screen.findByText('Warning:');
    const box = word.closest('div[class*="status-warn"]') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('AGENFK_HUB_ORG_ID=org-123');
  });

  it('is on tokens only', async () => {
    mockApi({ pendingEnv: 'org-123' });
    const { container } = mount('/', '/', <Layout><div>content</div></Layout>);
    await screen.findByText('Warning:');
    expectOnTokens(container);
  });
});

describe('Org rollup', () => {
  it('headline tiles use plain words, not validate ✓ / ✗', async () => {
    mockApi();
    mount('/', '/', <OrgPage />);
    for (const label of ['Items closed', 'Checks passed', 'Checks failed', 'PRs opened']) expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/Validate ✓|Validate ✗/)).toBeNull();
  });

  it('is on tokens only', async () => {
    mockApi();
    const { container } = mount('/', '/', <OrgPage />);
    await screen.findByText('alice@acme.com');
    expectOnTokens(container);
  });
});

describe('PR overview', () => {
  it('the PR search box shows keyboard focus', async () => {
    mockApi();
    mount('/prs', '/prs', <PrOverviewPage />);
    const input = await screen.findByPlaceholderText(/paste a PR URL/i);
    const box = input.parentElement as HTMLElement;
    expect(`${box.className} ${input.className}`).toMatch(/focus-within:ring-2|focus-visible:ring-2/);
  });

  it('is on tokens only, with a facet and a date range selected', async () => {
    mockApi();
    // Pre-selected facet chip (its remove button) and a custom date range (its clear button).
    const { container } = mount('/prs?projects=acme%2Fapi&from=2026-08-01&to=2026-08-20', '/prs', <PrOverviewPage />);
    await screen.findByRole('button', { name: 'Remove acme/api' });
    await screen.findByTitle('Clear date range');
    await screen.findByText('By developer');
    await screen.findByText(/re-?sized/i);
    expectOnTokens(container);
  });
});

describe('user page', () => {
  it('is on tokens only, badges included', async () => {
    mockApi();
    const { container } = mount('/users/alice%40acme.com', '/users/:userKey', <UserDetailPage />);
    // A timeline row, not the filter chips (which render before the timeline loads).
    await screen.findAllByText('Fix login');
    expectOnTokens(container);
  });
});

describe('entry pages', () => {
  it('sign-in is on tokens only', async () => {
    mockApi();
    const { container } = mount('/login', '/login', <LoginPage />);
    await screen.findByRole('button', { name: /Sign in/ });
    expectOnTokens(container);
  });

  it('setup is on tokens only', async () => {
    mockApi();
    const { container } = mount('/setup', '/setup', <SetupPage />);
    await screen.findByRole('button', { name: /Create admin/ });
    expectOnTokens(container);
  });

  it('connect is on tokens only', async () => {
    mockApi();
    const { container } = mount('/connect', '/connect', <ConnectPage />);
    await waitFor(() => expect(container.querySelector('input')).not.toBeNull());
    expectOnTokens(container);
  });
});
