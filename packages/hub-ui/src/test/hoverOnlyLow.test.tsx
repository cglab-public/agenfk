/**
 * @vitest-environment jsdom
 *
 * The low-severity hover-only gaps (STORY 501129d3, follow-up to f17f36a5 "No
 * hover-only information"). A title reaches a mouse, not a sighted keyboard
 * or touch user: cut-off values wrap instead, raw values behind a friendly
 * label are shown where there is room, and what a button does is said in a
 * visible hint it is described by.
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { FacetMultiselect } from '../components/FacetMultiselect';
import { FilterAccordion } from '../components/FilterAccordion';
import { Layout } from '../components/Layout';
import { ModelMetaFilter } from '../components/ModelMetaFilter';
import { ModelTable } from '../components/ModelTable';
import { Chip, StatTile } from '../components/ui';
import { AdminInstallations } from '../pages/Admin';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { AdminIdentities } from '../pages/AdminIdentities';
import { PrOverviewPage } from '../pages/PrOverview';
import type { ModelGroup } from '../pages/modelMappings';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

let table: Record<string, unknown> = {};
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    const hit = Object.keys(table).find(k => url === k || url.startsWith(`${k}?`));
    return { data: hit ? table[hit] : [] };
  });
  table = {};
});
afterEach(cleanup);

const mount = (el: React.ReactNode, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
/** The element holding exactly this text wraps it rather than cutting it. */
function expectWraps(el: HTMLElement, wrap: 'break-words' | 'break-all') {
  expect(classes(el)).not.toContain('truncate');
  expect(classes(el)).toContain(wrap);
}
/** The control is described by a hint that is on screen, not only in a title. */
function expectVisibleHint(control: HTMLElement, text: RegExp) {
  expect(control).toHaveAccessibleDescription(text);
  const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const hints = ids.map(id => document.getElementById(id)!).filter(Boolean);
  const hint = hints.find(h => text.test(h.textContent ?? ''));
  expect(hint).toBeDefined();
  expect(hint).toBeVisible();
  expect(classes(hint!)).not.toContain('sr-only');
}

const LONG = 'a-remarkably-long-value-that-a-narrow-column-would-cut@build-farm.example.internal';

describe('cut-off values wrap', () => {
  it('a selected facet pill wraps its label', () => {
    render(<FacetMultiselect label="Developer" options={[LONG, 'b', 'c', 'd', 'e', 'f', 'g', 'h']} selected={new Set([LONG])}
      onToggle={() => {}} onClear={() => {}} inlineThreshold={6} />);
    const pill = screen.getByRole('button', { name: `Remove ${LONG}` }).parentElement!;
    expectWraps(within(pill).getByText(LONG), 'break-words');
  });

  it('the signed-in name wraps at word boundaries', async () => {
    table = { '/auth/me': { userId: 'u1', orgId: 'o1', role: 'member', name: LONG }, '/healthz': { ok: true, version: '2.0.0' } };
    mount(<Layout><div>page</div></Layout>);
    const footer = await screen.findByTestId('sidebar-footer');
    expectWraps(await within(footer).findByText(LONG), 'break-words');
  });

  it('a signed-in opaque id wraps anywhere', async () => {
    table = { '/auth/me': { userId: LONG, orgId: 'o1', role: 'member' }, '/healthz': { ok: true, version: '2.0.0' } };
    mount(<Layout><div>page</div></Layout>);
    const footer = await screen.findByTestId('sidebar-footer');
    expectWraps(await within(footer).findByText(LONG), 'break-all');
  });

  it('a stat tile that is not a button wraps its value', () => {
    render(<StatTile label="Top model" value={LONG} />);
    expectWraps(screen.getByText(LONG), 'break-words');
  });

  it('the collapsed filter summary wraps', () => {
    render(<FilterAccordion activeCount={3} summary={LONG} open={false} onOpenChange={() => {}}><div /></FilterAccordion>);
    expectWraps(screen.getByText(LONG), 'break-words');
  });

  it('a filter chip wraps its label', () => {
    render(<Chip on={false} onClick={() => {}}>{LONG}</Chip>);
    expectWraps(screen.getByRole('button', { name: LONG }), 'break-words');
  });
});

describe('raw values behind a friendly label', () => {
  const OPTIONS = ['https://github.com/acme/api.git', 'https://github.com/acme/web.git', 'c', 'd', 'e', 'f', 'g', 'h'];
  const short = (v: string) => v.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

  it('a facet popover row shows the raw value under its label', () => {
    render(<FacetMultiselect label="Project" options={OPTIONS} selected={new Set()} onToggle={() => {}} onClear={() => {}}
      optionLabel={short} inlineThreshold={6} />);
    fireEvent.click(screen.getByRole('button', { name: /^Project/, expanded: false }));
    const box = screen.getByRole('checkbox', { name: /acme\/api/ });
    const row = box.closest('label')!;
    expect(within(row).getByText('acme/api')).toBeVisible();
    const raw = within(row).queryByText('https://github.com/acme/api.git');
    expect(raw).toBeInTheDocument();
    expect(raw).toBeVisible();
  });

  it('the row\'s checkbox is named by the label and described by the raw value', () => {
    render(<FacetMultiselect label="Project" options={OPTIONS} selected={new Set()} onToggle={() => {}} onClear={() => {}}
      optionLabel={short} inlineThreshold={6} />);
    fireEvent.click(screen.getByRole('button', { name: /^Project/, expanded: false }));
    const box = screen.getByRole('checkbox', { name: 'acme/api' });
    expect(box).toHaveAccessibleDescription('https://github.com/acme/api.git');
    expect(screen.getByRole('checkbox', { name: 'c' })).not.toHaveAccessibleDescription();
  });

  it('an inline chip shows the raw value under its label, as its description', () => {
    render(<FacetMultiselect label="Project" options={OPTIONS.slice(0, 3)} selected={new Set()} onToggle={() => {}} onClear={() => {}}
      optionLabel={short} inlineThreshold={6} />);
    const chip = screen.getByRole('button', { name: 'acme/api' });
    expect(within(chip).getByText('https://github.com/acme/api.git')).toBeVisible();
    expect(chip).toHaveAccessibleDescription('https://github.com/acme/api.git');
    expect(chip).not.toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'c' })).not.toHaveAccessibleDescription();
  });

  it('a popover row whose label is the raw value says it once', () => {
    render(<FacetMultiselect label="Model" options={['m1', 'm2', 'c', 'd', 'e', 'f', 'g']} selected={new Set()} onToggle={() => {}} onClear={() => {}}
      inlineThreshold={6} />);
    fireEvent.click(screen.getByRole('button', { name: /^Model/, expanded: false }));
    const row = screen.getByRole('checkbox', { name: 'm1' }).closest('label')!;
    expect(within(row).getAllByText('m1')).toHaveLength(1);
  });

  it('a selected pill names its raw value to a screen reader too', () => {
    render(<FacetMultiselect label="Project" options={OPTIONS} selected={new Set(['https://github.com/acme/api.git'])}
      onToggle={() => {}} onClear={() => {}} optionLabel={short} inlineThreshold={6} />);
    const pill = screen.getByRole('button', { name: 'Remove acme/api' }).parentElement!;
    expect(within(pill).queryByText('https://github.com/acme/api.git')).toBeInTheDocument();
  });

  it('a named developer in the heatmap: the name wraps, with no hover-only key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
    try {
      const sizes = { xs: 2, s: 0, m: 0, l: 0, xl: 0 };
      const overview = {
        period: { from: '2026-08-10T12:00:00.000Z', to: '2026-08-14T12:00:00.000Z' },
        buckets: ['xs', 's', 'm', 'l', 'xl'],
        totals: { prs: 2, sizePoints: 4, developers: 1, medianBucket: 'xs' },
        resized: { count: 0, grew: 0, shrank: 0 },
        byDay: [{ day: '2026-08-12', sizes, total: 2, devBySize: { xs: [{ user_key: 'alice@acme.com', count: 2 }], s: [], m: [], l: [], xl: [] } }],
        byDeveloper: [{ user_key: 'alice@acme.com', prs: 2, sizePoints: 4, sizes, daily: { '2026-08-12': 2 } }],
        byModel: [],
        prs: [],
        previous: null,
      };
      get.mockImplementation(async (url: string) => {
        if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
        if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
        if (url.startsWith('/v1/people')) return { data: { names: { 'alice@acme.com': 'Alice Liddell' } } };
        return { data: overview };
      });
      mount(<PrOverviewPage />, '/prs');
      const grid = await screen.findByRole('grid', { name: /PRs per developer, per day/i });
      const header = (await within(grid).findAllByRole('rowheader'))[0];
      expect(await within(header).findByText('Alice Liddell')).toBeVisible();
      // The name stands for the key (labelOf adds the key when two people share
      // a name), so the key is neither stacked under it nor left in a title.
      const name = within(header).getByText('Alice Liddell');
      expectWraps(name, 'break-words');
      expect(name).not.toHaveAttribute('title');
      expect(header.querySelector('[title]')?.getAttribute('title') ?? null).not.toBe('alice@acme.com');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the size counts', () => {
  it('each count says which size it is, not only in a title', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
    try {
      const sizes = { xs: 2, s: 1, m: 0, l: 0, xl: 0 };
      get.mockImplementation(async (url: string) => {
        if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
        if (url.startsWith('/v1/child-hubs')) return { data: { childHubs: [], hasLocal: true } };
        if (url.startsWith('/v1/people')) return { data: { names: {} } };
        return { data: {
          period: { from: '2026-08-10T12:00:00.000Z', to: '2026-08-14T12:00:00.000Z' },
          buckets: ['xs', 's', 'm', 'l', 'xl'],
          totals: { prs: 3, sizePoints: 6, developers: 1, medianBucket: 'xs' },
          resized: { count: 0, grew: 0, shrank: 0 },
          byDay: [], byModel: [], prs: [], previous: null,
          byDeveloper: [{ user_key: 'zed@acme.com', prs: 3, sizePoints: 6, sizes, daily: {} }],
        } };
      });
      mount(<PrOverviewPage />, '/prs');
      await screen.findAllByText('zed@acme.com');
      const counts = screen.queryAllByTestId('size-counts');
      expect(counts.length).toBeGreaterThan(0);
      // One spoken phrase per count, its size first.
      expect(Array.from(counts[0].children).map(c => c.textContent)).toEqual(['XS 2', 'S 1', 'M 0', 'L 0', 'XL 0']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what a button does is said on screen', () => {
  const ROWS = [
    { model: 'glm-5.2', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
    { model: 'claude-opus-5', provider: 'Anthropic', licenseClass: 'proprietary', license: 'Proprietary' },
    { model: 'mystery-9000', provider: null, licenseClass: null, license: null },
  ];

  it('the Unclassified provider points at Admin → Models in a visible hint', () => {
    render(<ModelMetaFilter rows={ROWS as never} selected={new Set()} onApply={() => {}} />);
    const provider = screen.getByRole('heading', { name: 'Provider' }).parentElement!;
    expectVisibleHint(within(provider).getByRole('button', { name: /^Unclassified/ }), /Admin → Models/);
    // The weights row's Unclassified points at the same place, not at the commercial hint.
    const weights = screen.getByRole('heading', { name: 'Weights' }).parentElement!;
    expectVisibleHint(within(weights).getByRole('button', { name: /^Unclassified/ }), /Admin → Models/);
  });

  it('the weights Unclassified explains itself when every model has a provider', () => {
    const rows = [
      { model: 'a', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary' },
      { model: 'b', provider: 'OpenAI', licenseClass: null, license: null },
    ];
    render(<ModelMetaFilter rows={rows as never} selected={new Set()} onApply={() => {}} />);
    const weights = screen.getByRole('heading', { name: 'Weights' }).parentElement!;
    expectVisibleHint(within(weights).getByRole('button', { name: /^Unclassified/ }), /Admin → Models/);
  });

  it('the commercial choice says it has no downloadable weights', () => {
    const rows = [
      { model: 'a', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary' },
      { model: 'b', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
    ];
    render(<ModelMetaFilter rows={rows as never} selected={new Set()} onApply={() => {}} />);
    expectVisibleHint(screen.getByRole('button', { name: /^Commercial/ }), /hosted API only/i);
  });

  it('the open-weights choice carries its caveat in a visible hint', () => {
    render(<ModelMetaFilter rows={ROWS as never} selected={new Set()} onApply={() => {}} />);
    expectVisibleHint(screen.getByRole('button', { name: /^Open weights/ }), /not open source/i);
  });

  it('Show retired says what retired means', async () => {
    table = { '/v1/admin/installations': [], '/v1/admin/hidden-users': [] };
    mount(<AdminInstallations />);
    expectVisibleHint(await screen.findByRole('button', { name: /show retired/i }), /excluded from upgrades/i);
  });

  const upgrades = (progress: Record<string, number>) => ({
    '/v1/admin/upgrade': { directives: [{
      directiveId: 'dir-1', targetVersion: '1.1.21', scope: { type: 'all' }, createdAt: '2026-09-30T10:00:00.000Z',
      createdByUserId: null, createdByEmail: null, requestIp: null, expiresAt: null,
      progress: { pending: 0, in_progress: 0, succeeded: 0, failed: 0, cancelled: 0, ...progress },
      targets: [],
    }] },
    '/v1/admin/installations': [],
    '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
    '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
    '/v1/admin/upgrade-dispatches': { dispatches: [] },
  });

  it('Refresh says it bypasses the cache', async () => {
    table = upgrades({});
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { name: /issue upgrade/i }));
    expectVisibleHint(await screen.findByRole('button', { name: /refresh/i }), /cache/i);
  });

  it('Cancel waiting says what it cancels', async () => {
    table = upgrades({ pending: 1 });
    mount(<AdminUpgrades />);
    expectVisibleHint(await screen.findByRole('button', { name: /^Cancel waiting/ }), /hasn't started/i);
  });

  it('explains only the row buttons that are on screen', async () => {
    table = upgrades({ pending: 1 });
    mount(<AdminUpgrades />);
    await screen.findByRole('button', { name: /^Cancel waiting/ });
    expect(screen.queryByText(/Clear stuck marks/)).toBeNull();
  });

  it('Clear stuck says a live upgrade keeps running', async () => {
    table = upgrades({ in_progress: 1 });
    mount(<AdminUpgrades />);
    expectVisibleHint(await screen.findByRole('button', { name: /^Clear stuck/ }), /keeps running/i);
  });

  it('Revert says where the events go', async () => {
    table = { '/v1/admin/identity-suggestions': [], '/v1/admin/user-keys/merges': [
      { id: 'm-1', from: 'old', to: 'new@acme.dev', eventsMoved: 5, mergedByEmail: 'a@x', revertedAt: null, createdAt: '2026-09-02' },
    ] };
    mount(<AdminIdentities />);
    expectVisibleHint(await screen.findByRole('button', { name: 'Revert merge of old into new@acme.dev' }), /original identity/i);
  });

  it('Unmap says the spelling becomes its own model again', () => {
    const group: ModelGroup = {
      canonicalModel: 'glm-5.2', prs: 3,
      aliases: [
        { model: 'glm-5.2', prs: 3, canonicalModel: 'glm-5.2', isMapped: false },
        { model: 'GLM5.2', prs: 0, canonicalModel: 'glm-5.2', isMapped: true },
      ],
      canonicalSeen: true, unusedMappings: [], createdBy: null,
    };
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ModelTable groups={[group]} metaRows={[] as never} loading={false} onError={() => {}} invalidate={vi.fn()}
          onUnmap={() => {}} unmapping={false} unmappedCount={0} unusedCount={0} />
      </QueryClientProvider>,
    );
    expectVisibleHint(screen.getByRole('button', { name: 'Unmap GLM5.2' }), /its own model/i);
  });
});
