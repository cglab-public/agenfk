/**
 * @vitest-environment jsdom
 *
 * Hub pages sit against the sidebar on a wide monitor. They used to be centred
 * (`mx-auto` under a max width), which on a 1900px screen opened a gap of a few
 * hundred pixels between the rail and the page. jsdom does no layout, so the
 * rule is pinned where it lives: one Page container, and every top-level page
 * renders inside it.
 */
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Page } from '../components/ui';
import { App } from '../App';
import { api } from '../api';

vi.mock('../components/Layout', () => ({ Layout: ({ children }: any) => <div>{children}</div> }));
vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

afterEach(() => { cleanup(); get.mockReset(); });

describe('Page', () => {
  it('caps the width but does not centre the content', () => {
    render(<Page>body</Page>);
    const el = screen.getByText('body');
    expect(el).toHaveAttribute('data-page');
    expect(el.className).toMatch(/\bmax-w-/);
    expect(el.className).not.toMatch(/\bmx-auto\b/);
  });
});

describe('top-level hub pages render inside Page', () => {
  const renderAt = (path: string) => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/auth/me')) return { data: { userId: 'admin@x', orgId: 'acme', role: 'admin' } };
      if (url.startsWith('/auth/providers')) return { data: { password: true, google: false, entra: false, requiresSetup: false } };
      // Valid empty answers: `{}` is not a timeline or a user list.
      if (url.startsWith('/v1/timeline')) return { data: { events: [] } };
      if (url.startsWith('/v1/users')) return { data: [] };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      // PR overview reads its lists straight off the response; an empty period.
      if (url.startsWith('/v1/prs/overview')) return { data: {
        period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
        buckets: ['xs', 's', 'm', 'l', 'xl'],
        totals: { prs: 0, sizePoints: 0, developers: 0, medianBucket: null },
        resized: { count: 0, grew: 0, shrank: 0 },
        byDay: [], byDeveloper: [], byModel: [], prs: [], previous: null,
      } };
      return { data: {} };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
      </QueryClientProvider>,
    );
  };

  for (const path of ['/admin', '/', '/prs', '/users/someone%40example.com']) {
    it(path, async () => {
      const { container } = renderAt(path);
      await screen.findAllByRole('heading');
      expect(container.querySelector('[data-page]')).not.toBeNull();
    });
  }
});
