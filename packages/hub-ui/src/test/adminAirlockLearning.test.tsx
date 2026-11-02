/**
 * @vitest-environment jsdom
 *
 * Admin → Airlock → Proposed hosts (GH-294, TEL-3). Hub-joined installations
 * cannot change the org's policy, so a person there forwards the hosts their
 * sessions reached; the hub lists them one row per host, however many
 * installations proposed it, and an admin allows some of them, which saves a
 * new (audited) revision against the one the list was read at. Nothing is
 * allowed without the admin.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AirlockLearningCard } from '../pages/AdminAirlockLearning';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const row = (host: string, over: Record<string, unknown> = {}) => ({
  host, installations: 1, hits: 3, proxyHits: 0, uploads: 0, evidence: 'agent-reported', clients: ['pi'],
  firstSeen: '2026-10-20T10:00:00.000Z', lastSeen: '2026-10-27T10:00:00.000Z', ...over,
});

const LIST = {
  revision: 4,
  hosts: [row('pkg.example.org', { installations: 3, hits: 12, proxyHits: 5, evidence: 'proxy' }), row('api.example.com')],
};

const renderCardWithClient = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><AirlockLearningCard /></QueryClientProvider>) };
};
const renderCard = () => renderCardWithClient();

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/airlock/learning') return { data: LIST };
    throw new Error(`unexpected GET ${url}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Admin → Airlock → Proposed hosts', () => {
  // User 2026-11-01: a long list scrolls within the viewport.
  it('scrolls the proposed hosts within the viewport', async () => {
    renderCard();
    const box = (await screen.findByRole('list', { name: 'Proposed hosts' })).closest('.overflow-y-auto');
    expect(box).not.toBeNull();
    expect(box!.className).toMatch(/max-h-\[/);
  });

  it('lists each host once, with how many installations proposed it and what it rests on', async () => {
    renderCard();
    const list = await screen.findByRole('list', { name: 'Proposed hosts' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('pkg.example.org');
    expect(items[0]).toHaveTextContent(/3 installations/);
    expect(items[0]).toHaveTextContent(/sandbox proxy/i);
    expect(items[1]).toHaveTextContent(/agent-reported/i);
  });

  it('allows the selected hosts at the revision the list was read at', async () => {
    post.mockResolvedValue({ data: { revision: 5 } });
    renderCard();
    const list = await screen.findByRole('list', { name: 'Proposed hosts' });
    fireEvent.click(within(list).getByRole('checkbox', { name: 'pkg.example.org' }));
    fireEvent.click(screen.getByRole('button', { name: /allow 1 selected host/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/airlock/learning/accept', { entries: [{ pattern: 'pkg.example.org', direction: 'download' }], expectedRevision: 4 }));
    expect(await screen.findByRole('status')).toHaveTextContent(/revision 5/);
  });

  it('nothing starts selected, and nothing is allowed until the admin presses Allow (review finding 4)', async () => {
    renderCard();
    const list = await screen.findByRole('list', { name: 'Proposed hosts' });
    expect(within(list).getAllByRole('checkbox').every(b => !(b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: /allow 0 selected hosts/i })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('a refresh keeps the selection by host: a deselected host stays deselected, a new host arrives unselected (review finding 4)', async () => {
    const { qc } = renderCardWithClient();
    const list = await screen.findByRole('list', { name: 'Proposed hosts' });
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(within(list).getByRole('checkbox', { name: 'pkg.example.org' }));
    get.mockImplementation(async () => ({ data: { ...LIST, hosts: [row('new.example.net', { installations: 5 }), ...LIST.hosts] } }));
    await qc.invalidateQueries({ queryKey: ['admin-airlock-learning'] });
    await screen.findByRole('checkbox', { name: 'new.example.net' });
    expect(screen.getByRole('checkbox', { name: 'new.example.net' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'pkg.example.org' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'api.example.com' })).toBeChecked();
  });

  it('shows the hub\'s refusal', async () => {
    post.mockRejectedValue({ response: { status: 409, data: { error: 'The policy changed since it was read. Reload and apply the change again.' } } });
    renderCard();
    await screen.findByRole('list', { name: 'Proposed hosts' });
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /allow 2 selected hosts/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed since it was read/);
  });

  it('says when no installation has proposed anything', async () => {
    get.mockImplementation(async () => ({ data: { revision: 4, hosts: [] } }));
    renderCard();
    expect(await screen.findByText(/no hosts proposed/i)).toBeInTheDocument();
  });
});

describe('Admin → Airlock → Proposed hosts: direction and wildcards (2026-11-02)', () => {
  const WILD = {
    revision: 4,
    hosts: [row('api.us5.datadoghq.com', { hits: 14 }), row('mcp.us5.datadoghq.com', { hits: 6, uploads: 2 }), row('docs.vendor.io')],
    wildcards: [{ pattern: '*.datadoghq.com', hosts: ['api.us5.datadoghq.com', 'mcp.us5.datadoghq.com'], hits: 20, uploads: 2, evidence: 'agent-reported' }],
  };
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url === '/v1/admin/airlock/learning') return { data: WILD };
      throw new Error(`unexpected GET ${url}`);
    });
  });

  it('each host says whether it was sent data, and its direction starts at what was seen', async () => {
    renderCard();
    const items = within(await screen.findByRole('list', { name: 'Proposed hosts' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/downloads only/i);
    expect(items[1]).toHaveTextContent(/sent data 2 times/i);
    expect((within(items[0]).getByLabelText('Direction for api.us5.datadoghq.com') as HTMLSelectElement).value).toBe('download');
    expect((within(items[1]).getByLabelText('Direction for mcp.us5.datadoghq.com') as HTMLSelectElement).value).toBe('both');
  });

  it('offers wildcards with the hosts they cover, and allows hosts and wildcards each with the direction picked', async () => {
    post.mockResolvedValue({ data: { revision: 5 } });
    renderCard();
    const hosts = await screen.findByRole('list', { name: 'Proposed hosts' });
    const wild = screen.getByRole('list', { name: 'Proposed wildcards' });
    expect(wild).toHaveTextContent(/covers api\.us5\.datadoghq\.com, mcp\.us5\.datadoghq\.com/);
    fireEvent.click(within(wild).getByRole('checkbox', { name: '*.datadoghq.com' }));
    fireEvent.change(within(wild).getByLabelText('Direction for *.datadoghq.com'), { target: { value: 'download' } });
    fireEvent.click(within(hosts).getByRole('checkbox', { name: 'docs.vendor.io' }));
    fireEvent.change(within(hosts).getByLabelText('Direction for docs.vendor.io'), { target: { value: 'upload' } });
    fireEvent.click(screen.getByRole('button', { name: /allow 2 selected/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/airlock/learning/accept', {
      entries: [{ pattern: 'docs.vendor.io', direction: 'upload' }, { pattern: '*.datadoghq.com', direction: 'download' }],
      expectedRevision: 4,
    }));
  });
});

describe('what is known of each host (user decisions 2026-11-02)', () => {
  it('its labels, reverse DNS name and projects, and a model hint said to be one', async () => {
    const context = { projects: ['spark'], reverseDns: 'ec2-16-170-214-92.eu-north-1.compute.amazonaws.com', hint: 'A build box agents polled over ssh.', hintBy: 'claude' };
    get.mockImplementation(async () => ({ data: { revision: 4, hosts: [row('16.170.214.92', { labels: ['cloud-machine'], context }), row('api.vendor.io', { labels: [], context: null })] } }));
    renderCard();
    const [box, plain] = within(await screen.findByRole('list', { name: 'Proposed hosts' })).getAllByRole('listitem');
    for (const s of ['cloud machine', 'ec2-16-170-214-92.eu-north-1.compute.amazonaws.com', 'spark', 'A build box agents polled over ssh.', 'claude']) expect(box.textContent, s).toContain(s);
    expect(within(box).getByText(/model hint/i)).toBeInTheDocument();
    expect(within(plain).queryByText(/model hint/i)).toBeNull();
  });

  it('labels read as words, never as their codes', async () => {
    get.mockImplementation(async () => ({ data: { revision: 4, hosts: [row('1.1.1.1', { labels: ['public-dns-resolver'] }), row('52.1.2.3', { labels: ['unnamed-address'] })] } }));
    renderCard();
    const text = (await screen.findByRole('list', { name: 'Proposed hosts' })).textContent ?? '';
    expect(text).toMatch(/public DNS resolver/);
    expect(text).toMatch(/address with no name/);
    expect(text).not.toMatch(/public-dns-resolver|unnamed-address/);
  });
});

describe('a direction picker is as wide as its choices (bug 351d88ca)', () => {
  it('never asks for the full width and its own width at once', async () => {
    renderCard();
    await screen.findByRole('list', { name: 'Proposed hosts' });
    for (const s of screen.getAllByRole('combobox')) {
      const classes = s.className.split(/\s+/);
      expect(classes.includes('w-full') && classes.includes('w-auto'), s.getAttribute('aria-label') ?? '').toBe(false);
    }
  });
});

describe('projects beyond those listed (review, 2026-11-02)', () => {
  it('says how many more there are', async () => {
    get.mockImplementation(async () => ({ data: { revision: 4, hosts: [row('api.vendor.io', { labels: [], context: { projects: ['a', 'b'], reverseDns: null, hint: null, hintBy: null }, moreProjects: 5 })] } }));
    renderCard();
    const list = await screen.findByRole('list', { name: 'Proposed hosts' });
    expect(list.textContent).toContain('seen in a, b and 5 more');
  });
});
