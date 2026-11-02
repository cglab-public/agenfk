/**
 * @vitest-environment jsdom
 *
 * GH-294 TEL-2: a card's details show that card's Airlock decisions, read with
 * GET /airlock/decisions?itemId=<card>. A card no decision was logged for shows
 * no Airlock section at all (an empty box on every card is noise). The list
 * refreshes when the server says a decision was logged.
 */
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SocketProvider } from '../SocketContext';
import { ThemeProvider } from '../ThemeContext';
import { CardAirlockDecisions } from '../components/CardAirlockDecisions';
import { CardDetailModal } from '../components/CardDetailModal';
import { ItemType, Status } from '../types';
import { api } from '../api';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});
window.HTMLElement.prototype.scrollTo = vi.fn();

vi.mock('../api', () => ({
  api: {
    getAirlockDecisions: vi.fn(),
    getItem: vi.fn(() => Promise.resolve({})),
    updateItem: vi.fn(() => Promise.resolve({})),
    listItems: vi.fn(() => Promise.resolve([])),
    listAgentRuns: vi.fn(() => Promise.resolve([])),
    listRunEvents: vi.fn(() => Promise.resolve([])),
    getGates: vi.fn(() => Promise.resolve({ step: 'TODO', approvalRequired: false, approvals: [], overrides: {}, lastChecks: null })),
    getCheckHistory: vi.fn(() => Promise.resolve([])),
  },
}));

const handlers = vi.hoisted(() => ({} as Record<string, Array<(payload: unknown) => void>>));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: (ev: string, cb: (payload: unknown) => void) => { (handlers[ev] ??= []).push(cb); },
    off: (ev: string, cb: (payload: unknown) => void) => { handlers[ev] = (handlers[ev] ?? []).filter(h => h !== cb); },
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

const DECISIONS = [
  { id: 2, ts: '2026-10-27T12:00:01.000Z', client: 'opencode', model: 'p/m', tool: 'proxy', capabilityKind: 'host', target: 'b.s3.amazonaws.com:443', decision: 'deny', rule: 'not-on-allow-list', mode: 'enforce', itemId: 'i1', source: 'proxy', alert: 'cloud-storage' },
  { id: 1, ts: '2026-10-27T12:00:00.000Z', client: 'pi', model: null, tool: 'bash', capabilityKind: 'command', target: 'unshare -r sh', decision: 'deny', rule: 'namespace-escape', mode: 'observe', itemId: 'i1', source: 'tool' },
];

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}><SocketProvider><ThemeProvider>{children}</ThemeProvider></SocketProvider></QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(api.getAirlockDecisions).mockResolvedValue({ decisions: DECISIONS } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("a card's Airlock section", () => {
  it("asks for this card's decisions only", async () => {
    render(<CardAirlockDecisions itemId="i1" />, { wrapper });
    await screen.findByRole('region', { name: 'Airlock' });
    expect(api.getAirlockDecisions).toHaveBeenCalledWith(expect.any(Number), { itemId: 'i1' });
  });

  it('lists each decision with its rule, source, client, target and alert', async () => {
    render(<CardAirlockDecisions itemId="i1" />, { wrapper });
    const section = await screen.findByRole('region', { name: 'Airlock' });
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/not-on-allow-list/);
    expect(rows[0].textContent).toMatch(/proxy/);
    expect(rows[0].textContent).toMatch(/opencode/);
    expect(within(rows[0]).getByText('b.s3.amazonaws.com:443')).toBeTruthy();
    expect(rows[0].getAttribute('data-alert')).toBe('cloud-storage');
    expect(rows[0].textContent).toMatch(/cloud storage upload/i);
    expect(rows[1].textContent).toMatch(/namespace-escape/);
    expect(rows[1].textContent).toMatch(/observed/);
    expect(rows[1].getAttribute('data-alert')).toBeNull();
  });

  it('a card with no decisions shows no Airlock section', async () => {
    vi.mocked(api.getAirlockDecisions).mockResolvedValue({ decisions: [] } as never);
    render(<CardAirlockDecisions itemId="i1" />, { wrapper });
    await waitFor(() => expect(api.getAirlockDecisions).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Airlock' })).toBeNull();
  });

  it('refreshes when a decision is logged', async () => {
    vi.mocked(api.getAirlockDecisions).mockResolvedValue({ decisions: [] } as never);
    render(<CardAirlockDecisions itemId="i1" />, { wrapper });
    await waitFor(() => expect(api.getAirlockDecisions).toHaveBeenCalledTimes(1));
    vi.mocked(api.getAirlockDecisions).mockResolvedValue({ decisions: DECISIONS } as never);
    await act(async () => { (handlers.airlock_decision ?? []).forEach(h => h({ decision: 'deny' })); });
    expect(await screen.findByRole('region', { name: 'Airlock' })).toBeTruthy();
  });

  it('the card details modal shows it on the Overview', async () => {
    const item = { id: 'i1', projectId: 'p1', type: ItemType.TASK, title: 'A card', description: '', status: Status.TODO, createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(api.getItem).mockResolvedValue(item as never);
    render(
      <CardDetailModal item={item as unknown as React.ComponentProps<typeof CardDetailModal>['item']} allItems={[]} onClose={() => {}} onSelectItem={() => {}} onAddItem={async () => {}} onDeleteItem={async () => {}} />,
      { wrapper },
    );
    const section = await screen.findByRole('region', { name: 'Airlock' });
    expect(within(section).getByText('b.s3.amazonaws.com:443')).toBeTruthy();
    expect(api.getAirlockDecisions).toHaveBeenCalledWith(expect.any(Number), { itemId: 'i1' });
  });
});
