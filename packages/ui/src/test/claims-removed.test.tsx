/**
 * @file 26c059f6 — claims are gone from the board.
 *
 * A card's row carried a chip naming the paths it claimed, amber when another
 * card held them, and the fleet sheet held a child back when a sibling claimed
 * the same files. With claims removed neither says anything: an old card that
 * still carries a claim shows no chip, and its fan-out launches every child.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() }]),
    listActiveItems: vi.fn(async () => []),
    listItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    updateSettings: vi.fn(async () => ({ tmuxByDefault: false })),
    listTerminalSessions: vi.fn(async () => []),
    recordTerminalSession: vi.fn(async () => ({ id: 'row-1' })),
    forgetTerminalSession: vi.fn(async () => {}),
    getGitStatus: vi.fn(async () => ({ changed: 0, staged: 0, files: [] })),
  },
}));
/*
 * The handlers are captured, not discarded. `running` is NOT read off
 * AgentRun.status - the hook never closes a run, so status would light every
 * card that ever had one - it is recency of `run:event`. Without emitting one
 * there is no way to produce the state at all, and a counter tested only on
 * idle rows is a counter tested on the case that does not matter.
 */
const socketHandlers: Record<string, ((p: unknown) => void) | undefined> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true,
    connect: vi.fn(),
    on: vi.fn((event: string, cb: (p: unknown) => void) => { socketHandlers[event] = cb; }),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

const renderShell = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><div>board</div></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);


import { planFleet, type FleetInputs } from '../fleetPlan';

describe('the claim chip', () => {
  it('is not drawn, even for an old card another card "holds"', async () => {
    const mine = { id: 'mine', projectId: 'p1', type: 'TASK', title: 'Mine', status: 'IN_PROGRESS', claims: ['packages/ui/'] };
    const holder = { id: 'holder', projectId: 'p1', type: 'TASK', title: 'Holder', status: 'PAUSED', claims: ['packages/ui/src/App.tsx'] };
    vi.mocked(api.listActiveItems).mockResolvedValue([mine] as never);
    (api as unknown as { listItems: ReturnType<typeof vi.fn> }).listItems.mockResolvedValue([mine, holder]);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
    await screen.findByRole('button', { name: /mine/i });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(screen.queryByTestId('card-claims')).toBeNull();
  });
});

describe('the fleet plan', () => {
  const OK: FleetInputs['depth'] = { allowed: true, reason: null };
  type Item = FleetInputs['all'][number];
  const kid = (id: string, claims?: string[]): Item =>
    ({ id, title: `t-${id}`, status: 'TODO', parentId: 'epic', claims } as Item);
  const epic = { id: 'epic', title: 'The epic', status: 'IN_PROGRESS' } as Item;

  it('launches every child, whatever old claims they carry', () => {
    const p = planFleet({ parentId: 'epic', all: [epic, kid('a', ['shared/']), kid('b', ['shared/file.ts']), kid('c')], depth: OK });
    expect(p.children.map(c => c.launch)).toEqual([true, true, true]);
    expect(p.children.some(c => /claim/.test(String(c.hold ?? '')))).toBe(false);
  });
});
