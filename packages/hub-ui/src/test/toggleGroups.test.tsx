/**
 * @vitest-environment jsdom
 *
 * Toggle buttons sit in a named group and report their state (TASK 04b3a919,
 * story "Names and state on every control"). A row of pressed/unpressed
 * buttons reads to a screen reader as loose buttons — "All (12)", "day" —
 * unless a named group says what they choose. The hub's pattern (as in
 * PeriodControl) is aria-pressed buttons inside a role="group" with a name.
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';
import { ChildHubPicker } from '../pages/childHubPicker';
import { AdminUpgrades } from '../pages/AdminUpgrades';
import { AdminUsers } from '../pages/Admin';
import { RegistrySourcePicker } from '../pages/AdminFlows';
import { TimelineBar } from '../components/TimelineBar';
import { MetricsTilesRow } from '../components/MetricsTilesRow';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};

/** The named group holding exactly these buttons, each with its pressed state. */
function expectGroup(name: string | RegExp, buttons: Array<[RegExp, boolean]>) {
  const group = screen.getByRole('group', { name });
  for (const [label, pressed] of buttons) {
    const btn = within(group).getByRole('button', { name: label });
    expect(btn).toHaveAttribute('aria-pressed', String(pressed));
  }
  return group;
}

beforeEach(() => { get.mockReset(); localStorage.clear(); });
afterEach(cleanup);

describe('child hub picker', () => {
  it('groups All / Selected under the name its owner gives it', () => {
    mount(
      <ChildHubPicker
        groupLabel="Send to"
        childHubs={[{ id: 'c1', name: 'EU hub' } as any]}
        mode="all"
        selected={new Set()}
        onMode={() => {}}
        onToggle={() => {}}
        testIdPrefix="t"
      />,
    );
    expectGroup('Send to', [[/^All child hubs/, true], [/^Selected/, false]]);
  });
});

describe('upgrade scope', () => {
  it('is a group named by its visible "Scope" caption', async () => {
    const table: Record<string, unknown> = {
      '/v1/admin/upgrade': { directives: [] },
      '/v1/admin/installations': [],
      '/v1/admin/upgrade/available-versions': { versions: ['1.1.21'], fleetFloor: null },
      '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/upgrade-dispatches': { dispatches: [] },
    };
    get.mockImplementation(async (url: string) => ({ data: table[url] ?? {} }));
    mount(<AdminUpgrades />);
    fireEvent.click(await screen.findByRole('button', { name: /issue upgrade/i }));

    expectGroup('Scope', [[/^All/, true], [/^Selected/, false]]);
  });
});

describe('user invite', () => {
  it('auth method is a named group whose buttons report which one is chosen', async () => {
    get.mockResolvedValue({ data: [] });
    mount(<AdminUsers />);
    await screen.findByPlaceholderText('alice@acme.com');

    const group = expectGroup('Auth method', [[/^Password$/, true], [/^SSO only$/, false]]);
    fireEvent.click(within(group).getByRole('button', { name: /^SSO only$/ }));
    expectGroup('Auth method', [[/^Password$/, false], [/^SSO only$/, true]]);
  });

  it('auth method is not wrapped in a <label>, which named and pressed the first button', async () => {
    get.mockResolvedValue({ data: [] });
    mount(<AdminUsers />);
    await screen.findByPlaceholderText('alice@acme.com');

    const group = screen.getByRole('group', { name: 'Auth method' });
    expect(group.closest('label')).toBeNull();
    expect(within(group).getByRole('button', { name: /^Password$/ })).toHaveAccessibleName('Password');
  });
});

describe('flow registry source', () => {
  it('is a group named "Registry source"', () => {
    mount(<RegistrySourcePicker options={[{ value: 'org', label: 'acme/flows' }, { value: 'community', label: 'Community' }]} value="community" onChange={() => {}} />);
    expectGroup('Registry source', [[/^acme\/flows$/, false], [/^Community$/, true]]);
  });

  it('reports the choice through onChange', () => {
    const onChange = vi.fn();
    mount(<RegistrySourcePicker options={[{ value: 'org', label: 'acme/flows' }, { value: 'community', label: 'Community' }]} value="community" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'acme/flows' }));
    expect(onChange).toHaveBeenCalledWith('org');
  });
});

describe('activity timeline', () => {
  beforeEach(() => { get.mockResolvedValue({ data: { buckets: [], bucket: 'day' } }); });

  it('groups the range buttons as "Period" and the bucket buttons as "Bucket size"', async () => {
    mount(<TimelineBar />);
    await screen.findAllByRole('button');

    const period = screen.getByRole('group', { name: 'Period' });
    expect(within(period).getAllByRole('button').length).toBeGreaterThan(1);
    expect(within(period).getAllByRole('button').filter(b => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expectGroup('Bucket size', [[/^day$/, true], [/^hour$/, false]]);
  });
});

describe('metric tiles', () => {
  it('are a group named for what they filter, when they filter', () => {
    mount(<MetricsTilesRow totals={{ events: 10, closed: 2, passes: 3, fails: 1, prsOpened: 1 }} selectedTypes={new Set()} onFilterTypes={() => {}} />);
    const group = screen.getByRole('group', { name: 'Filter by event type' });
    expect(within(group).getAllByRole('button')).toHaveLength(4);
  });

  it('are no group when they are plain numbers', () => {
    mount(<MetricsTilesRow totals={{ events: 10, closed: 2, passes: 3, fails: 1, prsOpened: 1 }} />);
    expect(screen.queryByRole('group')).toBeNull();
  });
});
