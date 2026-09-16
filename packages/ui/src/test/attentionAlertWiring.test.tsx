/**
 * @vitest-environment jsdom
 *
 * The alert has a real caller.
 *
 * `attentionAlert.test.ts` proves the rules and `attentionSound.test.ts` proves
 * the noise. Neither of them proves the thing this branch keeps getting wrong:
 * that anything in the app ever calls them. A decision function that is
 * correct, covered and reachable from no code path is the defect that has been
 * found here twice, and both times every test it had was green.
 *
 * So this file drives the whole path the way the app does — open a terminal
 * through the sidebar, then have the bridge report the activity the MAIN
 * PROCESS actually emits on `pty:activity` — and asserts the sound and the
 * banner come out the other end. The bridge is faked; everything between
 * `onActivity` and the alert is the real code.
 *
 * The settings come from the same query key the settings screen writes, so a
 * switch flipped there and this path cannot disagree.
 */
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { AppShell } from '../components/AppShell';
import { ActiveProjectProvider } from '../ActiveProject';
import { SocketProvider } from '../SocketContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
    ]),
    listActiveItems: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => null),
    updateItem: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async () => ({})),
    listTerminalSessions: vi.fn(async () => []),
    recordTerminalSession: vi.fn(async (s: Record<string, unknown>) => ({ id: 'row-1', ...s })),
    forgetTerminalSession: vi.fn(async () => {}),
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(),
  })),
}));

/** The sound, stubbed at its own module boundary so nothing needs Web Audio. */
const played = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../attentionSound', () => ({
  playAttentionSound: played,
  // Mocked alongside it. A partial module mock leaves `browserSoundDeps`
  // undefined, and the component then throws inside an effect — which shows up
  // as every test in this file failing for a reason that has nothing to do with
  // what they assert.
  browserSoundDeps: vi.fn(() => ({})),
}));

let activityHandlers: Array<(e: { sessionId: string; activity: string }) => void>;
let noticeCalls: Array<Record<string, unknown>>;

const ALL_ON = {
  tmuxByDefault: false,
  attentionAlerts: true,
  attentionSound: true,
  soundTiming: 'always',
  osNotifications: true,
};

const setBridge = () => {
  activityHandlers = [];
  noticeCalls = [];
  Object.defineProperty(window, 'agenfkDesktop', {
    value: {
      isDesktop: true, platform: 'darwin',
      versions: { electron: '40', chrome: '1', node: '24' },
      prefs: { get: async () => ({ autoApprove: false }), setAutoApprove: async () => ({ autoApprove: false }) },
      notifications: {
        attention: async (req: Record<string, unknown>) => { noticeCalls.push(req); return true; },
      },
      sounds: { read: async () => ({ dataUrl: null, name: null }) },
      terminal: {
        spawn: async () => ({ sessionId: 'pty-1', agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
        write: async () => true,
        resize: async () => true,
        kill: async () => true,
        onData: () => () => {},
        onExit: () => () => {},
        onActivity: (_id: string, cb: (e: { sessionId: string; activity: string }) => void) => {
          activityHandlers.push(cb);
          return () => { activityHandlers = activityHandlers.filter(h => h !== cb); };
        },
        listAgents: async () => [
          // The shell's own default. Naming a different agent here would make
          // the banner assertion below about the fixture rather than about the
          // session the app actually opened.
          { id: 'claude-code', label: 'Claude Code', installed: true, supportsAutoApprove: true },
        ],
        refreshAgents: async () => [],
        sessionPersistence: async () => ({ available: false }),
      },
    },
    configurable: true, writable: true,
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  played.mockResolvedValue(true);
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: 'p1', name: 'agenfk', createdAt: new Date(), updatedAt: new Date() },
  ] as never);
  vi.mocked(api.listActiveItems).mockResolvedValue([
    { id: 'i1', projectId: 'p1', type: 'TASK', title: 'Something in agenfk', status: 'IN_PROGRESS' },
  ] as never);
  vi.mocked(api.listTerminalSessions).mockResolvedValue([] as never);
  vi.mocked(api.getSettings).mockResolvedValue(ALL_ON as never);
  vi.mocked(api.recordTerminalSession).mockImplementation(
    async (s) => ({ id: 'row-1', openedAt: new Date().toISOString(), ...s }) as never,
  );
  setBridge();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(q => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).agenfkDesktop;
});

const renderShell = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ActiveProjectProvider>
      <SocketProvider>
        <AppShell><div>board</div></AppShell>
      </SocketProvider>
    </ActiveProjectProvider>
  </QueryClientProvider>,
);

/** Open a terminal the way a user does, so the real onActivity wiring runs. */
const openTerminal = async (): Promise<void> => {
  renderShell();
  fireEvent.click(await screen.findByRole('button', { name: 'Expand agenfk' }));
  fireEvent.click(await screen.findByTitle('Something in agenfk'));
  fireEvent.click(await screen.findByRole('button', { name: /^create/i }));
  // The pane subscribes after the spawn resolves. Without waiting there is no
  // handler to fire and the test would pass against an app that never wires one.
  await waitFor(() => expect(activityHandlers.length).toBeGreaterThan(0));
};

const report = async (activity: string): Promise<void> => {
  await act(async () => {
    activityHandlers.forEach(h => h({ sessionId: 'pty-1', activity }));
    await Promise.resolve();
  });
};

describe('an agent that starts waiting for a person', () => {
  it('makes a sound', async () => {
    // THE test in this file. Everything from the bridge callback to the sound
    // is the app's own code.
    await openTerminal();
    await report('blocked');
    await waitFor(() => expect(played).toHaveBeenCalled());
  });

  it('asks the main process for an OS banner, naming the agent and the card', async () => {
    await openTerminal();
    await report('blocked');
    await waitFor(() => expect(noticeCalls).toHaveLength(1));
    expect(noticeCalls[0]).toMatchObject({
      agentLabel: 'Claude Code', cardTitle: 'Something in agenfk',
    });
  });

  it('says nothing when the agent is merely working', async () => {
    await openTerminal();
    await report('working');
    await report('idle');
    expect(played).not.toHaveBeenCalled();
    expect(noticeCalls).toHaveLength(0);
  });

  it('alerts once, not on every repeat of the same state', async () => {
    // screenActivity re-reports 'blocked' for as long as the agent waits.
    await openTerminal();
    await report('blocked');
    await report('blocked');
    await report('blocked');
    await waitFor(() => expect(played).toHaveBeenCalledTimes(1));
    expect(noticeCalls).toHaveLength(1);
  });

  it('alerts again after the agent went back to work and stopped again', async () => {
    // A second question deserves a second alert. Remembering "already alerted"
    // forever would make the feature work once per session.
    await openTerminal();
    await report('blocked');
    await report('working');
    await report('blocked');
    await waitFor(() => expect(played).toHaveBeenCalledTimes(2));
  });
});

describe('the settings actually gate it', () => {
  it('stays silent with alerts turned off', async () => {
    // Read from the same query key the settings screen writes. A path with its
    // own copy of the preference is a second source of truth.
    vi.mocked(api.getSettings).mockResolvedValue({ ...ALL_ON, attentionAlerts: false } as never);
    await openTerminal();
    await report('blocked');
    expect(played).not.toHaveBeenCalled();
    expect(noticeCalls).toHaveLength(0);
  });

  it('shows the banner without the sound when only the sound is off', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...ALL_ON, attentionSound: false } as never);
    await openTerminal();
    await report('blocked');
    await waitFor(() => expect(noticeCalls).toHaveLength(1));
    expect(played).not.toHaveBeenCalled();
  });

  it('makes the sound without the banner when only the banner is off', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...ALL_ON, osNotifications: false } as never);
    await openTerminal();
    await report('blocked');
    await waitFor(() => expect(played).toHaveBeenCalled());
    expect(noticeCalls).toHaveLength(0);
  });
});

describe('where the app is not the desktop shell', () => {
  it('does not fall over when there is no bridge to notify through', async () => {
    // A browser has no main process, so `notifications` is simply absent. The
    // sound still works — it is Web Audio — and the missing banner must
    // degrade rather than throw inside a terminal callback.
    await openTerminal();
    delete (window as unknown as Record<string, unknown>).agenfkDesktop;
    await expect(report('blocked')).resolves.toBeUndefined();
  });
});
