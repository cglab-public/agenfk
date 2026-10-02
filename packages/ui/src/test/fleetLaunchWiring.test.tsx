/**
 * "Launch 3" has to launch three (ebc847da).
 *
 * THE COUNT WAS NEVER THE PROBLEM. The sheet counts honestly - `launchCount`
 * and the id list come off the same field of the same plan, and `fleetPlan`'s
 * own tests pin that. The DISPATCH end could only ever deliver one: the handler
 * looped over the cleared children calling `requestTerminal` for each, and
 * `pending` was a single-object `useState`, so three synchronous writes to one
 * slot left the last one standing. Exactly one dialog appeared, for the last
 * child in the list, and the other two were dropped with no row, no message and
 * no error while the person watched the sheet close believing a three-way
 * fan-out had started.
 *
 * That is the interface lie the card exists to prevent, relocated one layer
 * down from the number to the thing the number describes.
 *
 * WHY NOTHING CAUGHT IT: `FleetSheet.test.tsx` asserts `onLaunch` was called
 * with the right ids and stops at the component boundary. Nothing rendered the
 * SHELL and pressed the button, so the callback was verified and its effect
 * never was - complete at both ends, disconnected in the middle, which is the
 * defect this branch keeps finding in other people's code.
 *
 * So these tests drive the real shell and count what the user would see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(),
    listItems: vi.fn(),
    listActiveItems: vi.fn(),
    listRuns: vi.fn(),
    listAgentRuns: vi.fn(),
    listRunEvents: vi.fn(),
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

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(),
    emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

const EPIC = {
  id: 'epic-1', projectId: 'p1', type: 'EPIC', title: 'The fan-out', status: 'IN_PROGRESS',
};
const KIDS = ['alpha', 'beta', 'gamma'].map((name, n) => ({
  id: `kid-${n + 1}`, projectId: 'p1', parentId: 'epic-1', type: 'TASK',
  title: `Child ${name}`, status: 'TODO',
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.listActiveItems).mockResolvedValue([EPIC, ...KIDS] as never);
  vi.mocked(api.listItems).mockResolvedValue([EPIC, ...KIDS] as never);
  vi.mocked(api.listRuns).mockResolvedValue([] as never);
  vi.mocked(api.listAgentRuns).mockResolvedValue([] as never);
  vi.mocked(api.listRunEvents).mockResolvedValue([] as never);
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

/** Open the fleet sheet the way a person does: the epic's fleet control. */
const openTheSheet = async (): Promise<boolean> => {
  // By test id, not by accessible name: the control's label is "Plan a fan-out
  // of <title>", so matching on the word "fleet" finds nothing and the test
  // would no-op while looking like it ran.
  const fleet = await screen.findAllByTestId('card-fleet').catch(() => [] as HTMLElement[]);
  if (!fleet.length) return false;
  fireEvent.click(fleet[0]);
  return true;
};

describe('pressing Launch N', () => {
  it('asks about EVERY cleared child, not just the last one', async () => {
    /*
     * THE test. With a single `pending` slot this asked about `kid-3` alone and
     * silently discarded the other two. The assertion is deliberately about the
     * COUNT of cards queued rather than about one title: a fix that happened to
     * keep the first instead of the last would be just as wrong.
     */
    renderShell();
    if (!await openTheSheet()) return expectSheetReachable();

    const launch = await screen.findByRole('button', { name: /launch\s*3/i });
    fireEvent.click(launch);

    // One dialog on screen at a time - three at once would be a stack of modals
    // nobody can answer. The rest are queued behind it.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Answering the head must reveal the next, and the next, until all three
    // have been asked. A single-slot implementation closes after the first.
    const asked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const open = screen.queryByRole('dialog');
      if (!open) break;
      asked.push(open.textContent ?? '');
      const close = screen.getAllByRole('button', { name: /cancel|close|fechar/i })[0];
      if (!close) break;
      fireEvent.click(close);
      await waitFor(() => undefined);
    }
    expect(asked.length, 'the wave was cut short: only these were asked').toBe(3);
  });

  it('dismissing one does not throw away the rest of the wave', async () => {
    /*
     * The single-slot habit surviving the queue: clearing on close rather than
     * shifting. It fails in the direction that loses work silently - the person
     * skips one card and the other two vanish without ever being offered.
     */
    renderShell();
    if (!await openTheSheet()) return expectSheetReachable();

    fireEvent.click(await screen.findByRole('button', { name: /launch\s*3/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getAllByRole('button', { name: /cancel|close|fechar/i })[0]);
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog'),
        'dismissing one question closed the whole queue',
      ).toBeInTheDocument();
    });
  });
});

/**
 * The sheet is reached through the sidebar tree, which needs the epic to be in
 * an ACTIVE step - and `listActiveItems` is what supplies it. If the control is
 * not reachable in this harness the tests above prove nothing, so say that out
 * loud rather than passing quietly: a test that silently no-ops is the failure
 * mode this whole file exists to catch.
 */
function expectSheetReachable(): void {
  throw new Error(
    'The fleet control was not reachable in this harness, so nothing about Launch N was verified. '
    + 'Fix the fixture rather than deleting the assertion.',
  );
}
