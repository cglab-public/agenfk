/**
 * @vitest-environment jsdom
 *
 * INFRA-425: the renderer's half of the appearance preferences.
 *
 * The desktop stores `uiScale` and `terminalFontSize` (see the desktop's
 * appearancePrefs.test.ts for the border). This side reads them, offers them in
 * Settings > Appearance, and builds every terminal at the stored font size —
 * including the ones already open when the size changes, because a setting that
 * only applies to the next terminal reads as a setting that did nothing.
 */
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import { readPrefsFromBridge, setUiScaleOnBridge, setTerminalFontSizeOnBridge, onPrefsChangedFromBridge } from '../components/agentBridge';
import { TERMINAL_OPTIONS, terminalOptionsFor, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX } from '../terminalOptions';
import { TerminalPane } from '../components/TerminalPane';
import { SettingsPanel } from '../components/SettingsPanel';

vi.mock('../api', () => ({
  api: {
    getVersion: vi.fn(async () => ({ version: '2.0.0' })),
    getLatestRelease: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
    getSettingsRuntime: vi.fn(async () => ({ cpus: 4, automaticSuiteRuns: 2, suiteRunLimit: 2 })),
    getGitHubAccount: vi.fn(async () => ({ connected: false, reason: 'not_authenticated' })),
    signOutGitHub: vi.fn(async () => ({ signedOut: true })),
    getTelemetryConfig: vi.fn(async () => ({ telemetryEnabled: false, installationId: 'i' })),
    setTelemetryConfig: vi.fn(async (enabled: boolean) => ({ telemetryEnabled: enabled })),
  },
}));

type Win = { agenfkDesktop?: { prefs?: Record<string, unknown> } };

const installPrefs = (prefs: Record<string, unknown> | undefined): void => {
  (window as unknown as Win).agenfkDesktop = prefs ? { prefs } : undefined;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Win).agenfkDesktop;
});

describe('reading the preferences', () => {
  it('answers the sizes the app has always drawn when there is no desktop host', async () => {
    installPrefs(undefined);
    expect(await readPrefsFromBridge()).toMatchObject({ uiScale: 1, terminalFontSize: 12 });
  });

  it('answers the defaults for a preload that predates the keys', async () => {
    installPrefs({ get: async () => ({ autoApprove: false }) });
    expect(await readPrefsFromBridge()).toMatchObject({ uiScale: 1, terminalFontSize: 12 });
  });

  it('passes stored values through', async () => {
    installPrefs({ get: async () => ({ autoApprove: false, uiScale: 1.5, terminalFontSize: 16 }) });
    expect(await readPrefsFromBridge()).toMatchObject({ uiScale: 1.5, terminalFontSize: 16 });
  });

  it('refuses loudly when the build cannot store them', async () => {
    installPrefs({ get: async () => ({ autoApprove: false }) });
    await expect(setUiScaleOnBridge(1.5)).rejects.toThrow(/cannot store/);
    await expect(setTerminalFontSizeOnBridge(16)).rejects.toThrow(/cannot store/);
  });
});

describe('terminal options', () => {
  it('keep every other option and take the font size given', () => {
    expect(terminalOptionsFor(16)).toEqual({ ...TERMINAL_OPTIONS, fontSize: 16 });
  });

  it('fall back to the default size when none is known yet', () => {
    expect(terminalOptionsFor(undefined).fontSize).toBe(TERMINAL_OPTIONS.fontSize);
  });

  it('keep the size inside the range a terminal stays usable at', () => {
    expect(terminalOptionsFor(2).fontSize).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(terminalOptionsFor(99).fontSize).toBe(TERMINAL_FONT_SIZE_MAX);
    expect(terminalOptionsFor(NaN).fontSize).toBe(TERMINAL_OPTIONS.fontSize);
  });
});

describe('an open terminal follows the font size', () => {
  /*
   * A Proxy rather than the full fake in TerminalPane.test.tsx: this test only
   * cares about `options`, and every subscription the pane makes just needs
   * something with a dispose().
   */
  const fakeTerm = (initial: ITerminalOptions): { options: ITerminalOptions } & Record<string, unknown> => {
    const target: Record<string, unknown> = {
      options: { ...initial },
      cols: 80,
      rows: 24,
      buffer: { active: { baseY: 0, cursorY: 0, getLine: () => undefined } },
    };
    return new Proxy(target, {
      get: (t, prop: string) => (prop in t ? t[prop] : () => ({ dispose: () => {} })),
    }) as never;
  };

  it('restyles the SAME terminal, refits it and tells the pty, without restarting the agent', async () => {
    const bridge = {
      spawn: vi.fn(async () => ({ sessionId: 'sess-1' })),
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(async () => {}),
      onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
    };
    const made: Array<ReturnType<typeof fakeTerm>> = [];
    const fit = vi.fn();
    const props = {
      itemId: 'item-1',
      agentId: 'shell',
      bridge: bridge as never,
      createTerminal: (opts: ITerminalOptions) => { const t = fakeTerm(opts); made.push(t); return t as unknown as Terminal; },
      createFitAddon: () => ({ activate: () => {}, dispose: () => {}, fit }),
    };
    const { rerender } = render(<TerminalPane {...props} fontSize={16} />);
    expect(made[0].options.fontSize).toBe(16);
    await waitFor(() => expect(bridge.spawn).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    const fitsBefore = fit.mock.calls.length;
    bridge.resize.mockClear();
    await act(async () => { rerender(<TerminalPane {...props} fontSize={20} />); });

    // One terminal and one spawn: a rebuilt terminal would mean a killed agent.
    expect(made).toHaveLength(1);
    expect(bridge.spawn).toHaveBeenCalledTimes(1);
    expect(bridge.kill).not.toHaveBeenCalled();
    expect(made[0].options.fontSize).toBe(20);
    // A new font size changes how many columns fit; without a refit and a
    // resize the pty keeps the old geometry and every line wraps wrongly.
    expect(fit.mock.calls.length).toBeGreaterThan(fitsBefore);
    expect(bridge.resize).toHaveBeenCalledWith('sess-1', 80, 24);
  });
});

describe('the push from main', () => {
  it('reaches the page in the same shape as a read', async () => {
    let push: ((p: unknown) => void) | null = null;
    installPrefs({ get: async () => ({}), onChanged: (cb: (p: unknown) => void) => { push = cb; return () => {}; } });
    const seen: unknown[] = [];
    const off = onPrefsChangedFromBridge(p => seen.push(p));
    push!({ autoApprove: false, uiScale: 1.3, terminalFontSize: 15 });
    expect(seen[0]).toMatchObject({ uiScale: 1.3, terminalFontSize: 15, askBeforeOpening: true });
    off();
  });

  it('is a no-op without a desktop host', () => {
    installPrefs(undefined);
    expect(() => onPrefsChangedFromBridge(() => {})()).not.toThrow();
  });
});

describe('Settings > Appearance', () => {
  const renderPanel = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SettingsPanel /></QueryClientProvider>);
  };

  const desktopPrefs = (stored: Record<string, unknown>) => {
    const state = { autoApprove: false, defaultAgentId: 'shell', askBeforeOpening: true, uiScale: 1, terminalFontSize: 12, ...stored };
    const prefs = {
      get: vi.fn(async () => ({ ...state })),
      setUiScale: vi.fn(async (v: number) => { state.uiScale = v; return { ...state }; }),
      setTerminalFontSize: vi.fn(async (v: number) => { state.terminalFontSize = v; return { ...state }; }),
    };
    installPrefs(prefs);
    return prefs;
  };

  const openAppearance = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Appearance/ }));
  };

  it('shows the stored interface scale and terminal font size', async () => {
    desktopPrefs({ uiScale: 1.5, terminalFontSize: 16 });
    renderPanel();
    await openAppearance();
    const scale = await screen.findByRole('combobox', { name: /Interface scale/ });
    const font = await screen.findByRole('combobox', { name: /Terminal font size/ });
    await waitFor(() => expect((scale as HTMLSelectElement).value).toBe('1.5'));
    expect((font as HTMLSelectElement).value).toBe('16');
  });

  it('offers the whole range, in steps a person can tell apart', async () => {
    desktopPrefs({});
    renderPanel();
    await openAppearance();
    const scale = await screen.findByRole('combobox', { name: /Interface scale/ }) as HTMLSelectElement;
    const values = [...scale.options].map(o => Number(o.value));
    expect(values[0]).toBe(0.8);
    expect(values[values.length - 1]).toBe(2);
    expect([...scale.options].find(o => o.value === '1.5')?.textContent).toMatch(/150%/);
  });

  it('says where to set them instead of offering controls this build cannot store', async () => {
    installPrefs({ get: async () => ({ autoApprove: false }) });
    renderPanel();
    await openAppearance();
    expect(await screen.findByText(/Set in the AgEnFK desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Interface scale/ })).toBeNull();
  });

  it('saves a change through the desktop', async () => {
    const prefs = desktopPrefs({});
    renderPanel();
    await openAppearance();
    fireEvent.change(await screen.findByRole('combobox', { name: /Interface scale/ }), { target: { value: '1.3' } });
    await waitFor(() => expect(prefs.setUiScale).toHaveBeenCalledWith(1.3));
    fireEvent.change(await screen.findByRole('combobox', { name: /Terminal font size/ }), { target: { value: '18' } });
    await waitFor(() => expect(prefs.setTerminalFontSize).toHaveBeenCalledWith(18));
  });
});
