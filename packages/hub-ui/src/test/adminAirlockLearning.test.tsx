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
  host, installations: 1, hits: 3, proxyHits: 0, evidence: 'agent-reported', clients: ['pi'],
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
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/airlock/learning/accept', { hosts: ['pkg.example.org'], expectedRevision: 4 }));
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
