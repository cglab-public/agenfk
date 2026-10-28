/**
 * @vitest-environment jsdom
 *
 * GH-294 TEL-3: Airlock learning on the board. The proposed allowlist (hosts
 * sessions reached that no list names) is read when a person opens it, never
 * on its own. Each host shows what it rests on: the sandbox proxy, which the
 * agent cannot forge, or agent-reported tool calls and imported logs.
 *
 * Accepting is a person's act (user decision 2026-10-27):
 *  - standalone: the person allows some or all of the hosts, which writes a
 *    new local revision against the one the proposal was made from;
 *  - hub-joined: the hub owns the policy, so there is no Allow; the person
 *    sends the proposal to the hub, where an org admin accepts it.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AirlockLearning, learningApi } from '../components/AirlockLearning';
import { guardTokens } from './helpers/tokenGuard';

const host = (name: string, over: Record<string, unknown> = {}) => ({
  host: name, hits: 3, sources: { tool: 3, proxy: 0, import: 0 }, evidence: 'agent-reported',
  firstSeen: '2026-10-20T10:00:00.000Z', lastSeen: '2026-10-27T10:00:00.000Z', clients: ['pi'], cards: ['card-1'],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  proposal: {
    hosts: [
      host('pkg.example.org', { hits: 2, sources: { tool: 0, proxy: 2, import: 0 }, evidence: 'proxy' }),
      host('api.example.com'),
    ],
    excluded: [{ host: '169.254.169.254', reason: 'metadata-endpoint' }, { host: 'evil.example', reason: 'denied-host' }],
  },
  revision: 4, source: 'local', hubManaged: false,
  ...over,
});

beforeEach(() => {
  vi.spyOn(learningApi, 'get').mockResolvedValue(answer() as never);
  vi.spyOn(learningApi, 'accept').mockResolvedValue({ revision: 5 } as never);
  vi.spyOn(learningApi, 'forward').mockResolvedValue({ forwarded: 2 } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
guardTokens();

const renderIt = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AirlockLearning /></QueryClientProvider>);
  return qc;
};
const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: /proposed allowlist/i }));
  return screen.findByRole('list', { name: 'Proposed hosts' });
};

describe('Airlock learning: the proposal', () => {
  it('is not read until a person opens it', async () => {
    renderIt();
    expect(learningApi.get).not.toHaveBeenCalled();
    await open();
    expect(learningApi.get).toHaveBeenCalledTimes(1);
  });

  it('lists each host with its hits, clients and what it rests on, and says what was left out', async () => {
    renderIt();
    const list = await open();
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(r => within(r).getByRole('checkbox').getAttribute('aria-label'))).toEqual(['pkg.example.org', 'api.example.com']);
    expect(rows[0].textContent).toMatch(/sandbox proxy/i);
    expect(rows[1].textContent).toMatch(/agent-reported/i);
    expect(rows[1].textContent).toMatch(/3 hits/);
    expect(rows[1].textContent).toMatch(/pi/);
    expect(screen.getByText(/2 hosts left out/i)).toBeTruthy();
  });

  it('says when there is nothing to propose', async () => {
    vi.mocked(learningApi.get).mockResolvedValue(answer({ proposal: { hosts: [], excluded: [] } }) as never);
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /proposed allowlist/i }));
    expect(await screen.findByText(/no hosts to propose/i)).toBeTruthy();
  });
});

describe('Airlock learning: standalone', () => {
  it('allows the hosts the person selected, against the revision the proposal was made from', async () => {
    renderIt();
    const list = await open();
    fireEvent.click(within(list).getByRole('checkbox', { name: 'pkg.example.org' }));
    fireEvent.click(screen.getByRole('button', { name: /allow 1 selected host/i }));
    await waitFor(() => expect(learningApi.accept).toHaveBeenCalledWith({ hosts: ['pkg.example.org'], expectedRevision: 4 }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringMatching(/revision 5/));
    expect(screen.queryByRole('button', { name: /send .* to the hub/i })).toBeNull();
  });

  it('a conflict is shown, with nothing claimed', async () => {
    vi.mocked(learningApi.accept).mockRejectedValue({ response: { status: 409, data: { error: 'AIRLOCK_REVISION_CONFLICT', message: 'The policy changed since it was read.' } } });
    renderIt();
    await open();
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /allow 2 selected hosts/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/changed since it was read/));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('nothing starts selected, so nothing is allowed until the person picks (review finding 4)', async () => {
    renderIt();
    const list = await open();
    expect(within(list).getAllByRole('checkbox').every(b => !(b as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole('button', { name: /allow 0 selected hosts/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refresh keeps the selection by host: a deselected host stays deselected, a new host arrives unselected (review finding 4)', async () => {
    const qc = renderIt();
    const list = await open();
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(within(list).getByRole('checkbox', { name: 'pkg.example.org' }));
    const again = answer();
    again.proposal.hosts = [host('new.example.net', { hits: 9 }), ...again.proposal.hosts];
    vi.mocked(learningApi.get).mockResolvedValue(again as never);
    await qc.invalidateQueries({ queryKey: ['airlock-learning'] });
    const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'new.example.net' })).toBeTruthy());
    expect(box('new.example.net').checked).toBe(false);
    expect(box('pkg.example.org').checked).toBe(false);
    expect(box('api.example.com').checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /allow 1 selected host/i }));
    await waitFor(() => expect(learningApi.accept).toHaveBeenCalledWith({ hosts: ['api.example.com'], expectedRevision: 4 }));
  });
});

describe('Airlock learning: hub-joined', () => {
  beforeEach(() => {
    vi.mocked(learningApi.get).mockResolvedValue(answer({ hubManaged: true, source: 'hub' }) as never);
  });

  it('offers no Allow: the hub owns the policy, so the person sends the hosts to it', async () => {
    renderIt();
    await open();
    expect(screen.queryByRole('button', { name: /^allow/i })).toBeNull();
    expect(screen.getByText(/org admin/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /send 2 selected hosts to the hub/i }));
    await waitFor(() => expect(learningApi.forward).toHaveBeenCalledWith({ hosts: ['pkg.example.org', 'api.example.com'] }));
    expect(learningApi.accept).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringMatching(/sent 2 hosts/i));
  });
});
