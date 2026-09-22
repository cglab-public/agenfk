/**
 * Dragging the sidebar edge, in the shell rather than in the rule (107eb297).
 *
 * `sidebarWidth.test.ts` covers the arithmetic. What this covers is the part
 * that has failed repeatedly on this branch: a rule that is correct, tested,
 * and wired to nothing. The handle has to exist, the drag has to move the
 * element, the clamp has to be the one the module exports, and the number the
 * TERMINAL sizes itself from has to be the width that is actually on screen.
 *
 * That last one is the quiet failure. If the terminal keeps being told 224
 * while the sidebar is 380, nothing looks wrong: the agent's own output starts
 * wrapping at the wrong column, which reads as the agent misbehaving.
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
import { SIDEBAR_MIN_PX, SIDEBAR_MAX_PX, maxSidebarWidth } from '../sidebarWidth';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(), listItems: vi.fn(), listActiveItems: vi.fn(),
    listRuns: vi.fn(), listAgentRuns: vi.fn(), listRunEvents: vi.fn(),
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
/**
 * TerminalTab is stubbed so the prop it sizes itself from is OBSERVABLE.
 *
 * Without this the wiring is untestable and the failure is silent: mutating the
 * shell back to a fixed 224 left every test in this file green, in the file
 * whose own header calls that out as the defect to catch. A paragraph about a
 * risk is not a test for it.
 */
const terminalWidths: number[] = [];
vi.mock('../components/TerminalTab', () => ({
  TerminalTab: (props: { sidebarWidthPx?: number }) => {
    terminalWidths.push(props.sidebarWidthPx ?? -1);
    return <div data-testid="terminal-stub" />;
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(),
    emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

/** A window wide enough that the taste ceiling, not the terminal, is the limit. */
const WIDE = 1920;

const setWindowWidth = (px: number): void => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: px });
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setWindowWidth(WIDE);
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.listActiveItems).mockResolvedValue([] as never);
  vi.mocked(api.listItems).mockResolvedValue([] as never);
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

/** The <aside>, found through the handle so the test does not guess at markup. */
const sidebarEl = (): HTMLElement => {
  const handle = screen.getByTestId('sidebar-resize');
  const aside = handle.closest('aside');
  if (!aside) throw new Error('the handle is not inside an <aside>');
  return aside;
};

const widthOf = (el: HTMLElement): number => parseInt(el.style.width, 10);

/** Press on the handle and move the pointer to an absolute x. */
const dragTo = (x: number): void => {
  fireEvent.pointerDown(screen.getByTestId('sidebar-resize'));
  fireEvent.pointerMove(window, { clientX: x });
};

describe('the handle', () => {
  it('is there to grab', async () => {
    renderShell();
    expect(await screen.findByTestId('sidebar-resize')).toBeInTheDocument();
  });

  it('announces the range it moves within', async () => {
    // A separator with no min or max tells assistive tech nothing about how far
    // it can go, which is most of what a slider is for.
    renderShell();
    const handle = await screen.findByTestId('sidebar-resize');
    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_MIN_PX));
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAX_PX));
  });

  it('is absent, not inert, on a window with no room to grow', async () => {
    /*
     * A control that moves nothing when you pull it reads as a broken app. An
     * absent one reads as a narrow window, which is what it is.
     */
    setWindowWidth(700);
    renderShell();
    await screen.findByText(/agenfk/i);
    expect(screen.queryByTestId('sidebar-resize')).toBeNull();
  });
});

describe('dragging it', () => {
  it('actually widens the sidebar', async () => {
    /*
     * THE test of the wiring. The clamp being right proves nothing if the
     * element never reads it.
     */
    renderShell();
    await screen.findByTestId('sidebar-resize');
    expect(widthOf(sidebarEl())).toBe(SIDEBAR_MIN_PX);

    dragTo(340);
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(340));
  });

  it('refuses to go under the floor, however far left you pull', async () => {
    renderShell();
    await screen.findByTestId('sidebar-resize');
    dragTo(60);
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(SIDEBAR_MIN_PX));
  });

  it('stops at the ceiling, however far right you pull', async () => {
    renderShell();
    await screen.findByTestId('sidebar-resize');
    dragTo(5000);
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(maxSidebarWidth(WIDE)));
  });

  it('stops following the cursor once the button is released', async () => {
    // A drag that outlives the pointerup follows the cursor around the app for
    // ever after, and the only way out is a reload.
    renderShell();
    await screen.findByTestId('sidebar-resize');
    dragTo(320);
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(320));

    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientX: 400 });
    await waitFor(() => expect(widthOf(sidebarEl()), 'it kept dragging after release').toBe(320));
  });

  it('remembers the width across a remount', async () => {
    renderShell();
    await screen.findByTestId('sidebar-resize');
    dragTo(360);
    fireEvent.pointerUp(window);
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(360));

    cleanup();
    renderShell();
    await screen.findByTestId('sidebar-resize');
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(360));
  });

  it('pulls a stored width back in when the window is narrower than last time', async () => {
    /*
     * 400 px dragged on a big monitor, reopened on a 960 px window where the
     * ceiling is 368. The stored value has to go through the same clamp as the
     * drag, or a preference becomes a layout bug that survives restarts.
     *
     * The first version of this test used 360, which is UNDER that ceiling -
     * so it asserted the clamp would widen the sidebar, and the clamp only
     * ever pulls down. It went red, which is the point: a test written against
     * a misremembered rule is the one that ships the misremembering.
     */
    localStorage.setItem('agenfk_shell_sidebar_width', '400');
    setWindowWidth(960);
    renderShell();
    await screen.findByTestId('sidebar-resize');
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(maxSidebarWidth(960)));
  });
});

describe('what the terminal is told', () => {
  /**
   * A restored terminal, so TerminalTab is MOUNTED.
   *
   * It only renders behind `terminalOpened`, so without a session the stub is
   * never called and an assertion on what it was told passes vacuously - which
   * is how the first version of these two tests reported `undefined` instead of
   * a width.
   */
  const withATerminal = (): void => {
    /*
     * The desktop bridge, because the restore path is desktop-only: without it
     * the shell never spawns and TerminalTab never mounts. Minimal on purpose -
     * this file is about the sidebar, so the terminal only has to EXIST.
     */
    Object.defineProperty(window, 'agenfkDesktop', {
      writable: true, configurable: true,
      value: {
        isDesktop: true, platform: 'darwin',
        versions: { electron: '40', chrome: '1', node: '24' },
        prefs: { get: async () => ({ autoApprove: false }), setAutoApprove: async () => ({ autoApprove: false }) },
        terminal: {
          spawn: async () => ({ ok: true, agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
          listAgents: async () => [{ id: 'claude-code', label: 'Claude Code', available: true }],
          sessionPersistence: async () => ({ available: true }),
          onExit: () => () => {}, onData: () => () => {}, onActivity: () => () => {},
          write: async () => {}, resize: async () => {}, kill: async () => {},
        },
      },
    });
  };

  const _seed = (): void => {
    vi.mocked(api.listTerminalSessions).mockResolvedValue([{
      id: 'row-1', itemId: 'i1', projectId: 'p1', agentId: 'claude-code',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      openedAt: new Date().toISOString(),
    }] as never);
    vi.mocked(api.listActiveItems).mockResolvedValue([
      { id: 'i1', projectId: 'p1', type: 'TASK', title: 'A card', status: 'IN_PROGRESS' },
    ] as never);
  };
  const seedAndBridge = (): void => { withATerminal(); _seed(); };

  it('gets the width that is actually on screen, not the old constant', async () => {
    /*
     * THE test of the quiet failure. TerminalTab computes how many COLUMNS fit
     * from this number, so a sidebar that moves while the terminal is told 224
     * sizes the terminal for a sidebar that is no longer there - and the
     * symptom is not a visual one, it is the agent's own output wrapping at the
     * wrong column, which reads as the agent misbehaving.
     *
     * Written after mutating the shell back to the fixed 224 left the rest of
     * this file green.
     */
    seedAndBridge();
    terminalWidths.length = 0;
    renderShell();
    await screen.findByTestId('sidebar-resize');
    await waitFor(() => expect(terminalWidths.length, 'the terminal never mounted').toBeGreaterThan(0));

    dragTo(340);
    await waitFor(() => expect(widthOf(sidebarEl())).toBe(340));

    await waitFor(() => {
      expect(
        terminalWidths.at(-1),
        `the terminal was told ${terminalWidths.at(-1)} while the sidebar was 340`,
      ).toBe(340);
    });
  });

  it('is told the rail width when the sidebar is collapsed', async () => {
    // Collapsing gives the terminal room back. Reporting the open width there
    // would waste it, in the other direction and just as invisibly.
    seedAndBridge();
    terminalWidths.length = 0;
    renderShell();
    await screen.findByTestId('sidebar-resize');
    await waitFor(() => expect(terminalWidths.length, 'the terminal never mounted').toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /collapse|sidebar/i }));
    await waitFor(() => expect(terminalWidths.at(-1)).toBe(40));
  });
});

describe('the keyboard', () => {
  it('moves the edge with the arrow keys, so this is not a mouse-only feature', async () => {
    renderShell();
    const handle = await screen.findByTestId('sidebar-resize');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(widthOf(sidebarEl())).toBeGreaterThan(SIDEBAR_MIN_PX));

    const wider = widthOf(sidebarEl());
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(widthOf(sidebarEl())).toBeLessThan(wider));
  });

  it('is reachable by tab, which a div with no tabIndex would not be', async () => {
    renderShell();
    const handle = await screen.findByTestId('sidebar-resize');
    expect(handle).toHaveAttribute('tabIndex', '0');
  });
});
