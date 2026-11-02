/**
 * @vitest-environment jsdom
 *
 * GH-294 TEL-2: the board's Recent decisions list can be narrowed to one client
 * (pi / opencode) and one source (a tool call / the sandbox proxy). The filter
 * is the server's (GET /airlock/decisions?client=&source=), so the list shows
 * the newest matching decisions, not a filtered page of the newest overall.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import { AirlockSettings } from '../components/AirlockSettings';
import { api } from '../api';

vi.mock('axios');

const POLICY = {
  schemaVersion: 1, mode: 'enforce', models: [], appliesWhenModelUnknown: true,
  hosts: { allow: [], deny: [] }, iocHosts: { revision: '', hosts: [], updatedAt: null },
  rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' },
};

const row = (id: number, client: string, source: string) => ({
  id, ts: '2026-10-27T12:00:00.000Z', client, model: null, tool: source === 'proxy' ? 'proxy' : 'bash',
  capabilityKind: source === 'proxy' ? 'host' : 'command', target: `target-${id}`, decision: 'deny', rule: 'denied-host', mode: 'enforce', itemId: null, source,
});
const ALL = [row(4, 'pi', 'proxy'), row(3, 'opencode', 'tool'), row(2, 'opencode', 'proxy'), row(1, 'pi', 'tool')];

/** The server's filter, as a fake: what GET /airlock/decisions would answer. */
const serve = (params: Record<string, unknown> = {}) => ALL.filter(d =>
  (params.client === undefined || d.client === params.client) && (params.source === undefined || d.source === params.source));

beforeEach(() => {
  vi.spyOn(api, 'getAirlockPolicy').mockResolvedValue({ effective: POLICY, source: 'local', revision: 1, hubManaged: false, local: null, hub: null } as never);
  vi.spyOn(api, 'getAirlockApprovals').mockResolvedValue({ pending: [], recent: [] } as never);
  vi.mocked(axios.get).mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (String(url).endsWith('/airlock/decisions')) return { data: { decisions: serve(config?.params) } };
    throw new Error(`unexpected GET ${url}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderPanel = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AirlockSettings /></QueryClientProvider>,
);
const listed = () => within(screen.getByRole('list', { name: 'Recent decisions' })).getAllByRole('listitem').map(li => within(li).getByText(/^target-/).textContent);

describe('Recent decisions: client and source filters', () => {
  it('lists every client and source until one is chosen', async () => {
    renderPanel();
    await screen.findByText('target-4');
    expect(listed()).toEqual(['target-4', 'target-3', 'target-2', 'target-1']);
    expect((screen.getByLabelText('Filter by client') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Filter by source') as HTMLSelectElement).value).toBe('');
  });

  it('a client asks the server for that client only', async () => {
    renderPanel();
    await screen.findByText('target-4');
    fireEvent.change(screen.getByLabelText('Filter by client'), { target: { value: 'opencode' } });
    await waitFor(() => expect(listed()).toEqual(['target-3', 'target-2']));
    expect(axios.get).toHaveBeenLastCalledWith(expect.stringMatching(/\/airlock\/decisions$/), { params: expect.objectContaining({ client: 'opencode' }) });
  });

  it('a source asks for that source only, and combines with the client', async () => {
    renderPanel();
    await screen.findByText('target-4');
    fireEvent.change(screen.getByLabelText('Filter by source'), { target: { value: 'proxy' } });
    await waitFor(() => expect(listed()).toEqual(['target-4', 'target-2']));
    fireEvent.change(screen.getByLabelText('Filter by client'), { target: { value: 'pi' } });
    await waitFor(() => expect(listed()).toEqual(['target-4']));
    const params = vi.mocked(axios.get).mock.calls.at(-1)?.[1] as { params: Record<string, unknown> };
    expect(params.params).toMatchObject({ client: 'pi', source: 'proxy' });
  });

  it('back to all: the filter is dropped, not sent empty', async () => {
    renderPanel();
    await screen.findByText('target-4');
    fireEvent.change(screen.getByLabelText('Filter by client'), { target: { value: 'pi' } });
    await waitFor(() => expect(listed()).toEqual(['target-4', 'target-1']));
    fireEvent.change(screen.getByLabelText('Filter by client'), { target: { value: '' } });
    await waitFor(() => expect(listed()).toHaveLength(4));
    const params = vi.mocked(axios.get).mock.calls.at(-1)?.[1] as { params: Record<string, unknown> };
    expect(params.params).not.toHaveProperty('client');
    expect(params.params).not.toHaveProperty('source');
  });

  it('a filter that matches nothing says so, not "nothing stopped yet"', async () => {
    renderPanel();
    await screen.findByText('target-4');
    vi.mocked(axios.get).mockImplementation(async () => ({ data: { decisions: [] } }));
    fireEvent.change(screen.getByLabelText('Filter by client'), { target: { value: 'opencode' } });
    expect(await screen.findByText(/No decisions match/)).toBeTruthy();
  });

  it('shows where each decision came from', async () => {
    renderPanel();
    await screen.findByText('target-4');
    const items = within(screen.getByRole('list', { name: 'Recent decisions' })).getAllByRole('listitem');
    expect(items[0].textContent).toMatch(/proxy/);
    expect(items[1].textContent).toMatch(/tool/);
  });
});
