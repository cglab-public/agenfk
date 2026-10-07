/**
 * @vitest-environment jsdom
 *
 * INFRA-425: Settings > Terminal offers where terminals open, on a Windows
 * machine that has WSL. See the desktop's wsl.test.ts for the border.
 */
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

type Win = { agenfkDesktop?: Record<string, unknown> };

const install = (distros: string[] | undefined, stored = '') => {
  const state = { autoApprove: false, defaultAgentId: 'shell', askBeforeOpening: true, wslDistro: stored };
  const prefs = {
    get: vi.fn(async () => ({ ...state })),
    setWslDistro: vi.fn(async (v: string) => { state.wslDistro = v; return { ...state }; }),
  };
  (window as unknown as Win).agenfkDesktop = {
    prefs,
    ...(distros ? { wsl: { distros: vi.fn(async () => distros) } } : {}),
  };
  return prefs;
};

afterEach(() => { cleanup(); delete (window as unknown as Win).agenfkDesktop; });

const renderPanel = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><SettingsPanel /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /^Terminal$/ }));
};

describe('Settings > Terminal: where terminals open', () => {
  it('offers Windows and every installed distro', async () => {
    install(['Ubuntu', 'Debian']);
    await renderPanel();
    const select = await screen.findByRole('combobox', { name: /Open terminals in/ }) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map(o => o.value)).toEqual(['', 'Ubuntu', 'Debian']));
    expect([...select.options].map(o => o.textContent)).toEqual([
      expect.stringMatching(/Windows/), expect.stringMatching(/Ubuntu/), expect.stringMatching(/Debian/),
    ]);
  });

  it('shows the stored choice and saves a new one', async () => {
    const prefs = install(['Ubuntu'], 'Ubuntu');
    await renderPanel();
    const select = await screen.findByRole('combobox', { name: /Open terminals in/ }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('Ubuntu'));
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(prefs.setWslDistro).toHaveBeenCalledWith(''));
  });

  it('is not offered where there is no WSL', async () => {
    install([]);
    const distros = (window as unknown as { agenfkDesktop: { wsl: { distros: ReturnType<typeof vi.fn> } } }).agenfkDesktop.wsl.distros;
    await renderPanel();
    // Wait for the question to be ANSWERED, so this cannot pass by looking early.
    await waitFor(() => expect(distros).toHaveBeenCalled());
    // Let the answer land and the panel re-render before looking.
    await act(async () => { await distros.mock.results[0].value; });
    await screen.findByRole('switch', { name: /Ask before opening/ });
    expect(screen.queryByRole('combobox', { name: /Open terminals in/ })).toBeNull();
  });

  it('says so when the choice could not be stored', async () => {
    const prefs = install(['Ubuntu']);
    prefs.setWslDistro.mockRejectedValueOnce(new Error('Preference "wslDistro" must be one of: Ubuntu'));
    await renderPanel();
    fireEvent.change(await screen.findByRole('combobox', { name: /Open terminals in/ }), { target: { value: 'Ubuntu' } });
    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
  });
});
