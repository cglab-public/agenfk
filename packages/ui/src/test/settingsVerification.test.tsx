/**
 * @vitest-environment jsdom
 *
 * 7b640e64 — Settings has a Verification section: how many suite runs the
 * server runs at once, across every project. "Automatic" is half the CPUs
 * (the screen says what that is on this machine); a number is used as given,
 * up to the CPU count.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPanel } from '../components/SettingsPanel';
import { api } from '../api';
import { guardTokens } from './helpers/tokenGuard';

const STORED = vi.hoisted(() => ({ tmuxByDefault: false, attentionAlerts: true, attentionSound: true, soundTiming: 'unfocused' as const, osNotifications: true, maxConcurrentSuiteRuns: 0 }));
vi.mock('../api', () => ({
  api: {
    getVersion: vi.fn(async () => ({ version: '2.0.0' })),
    getLatestRelease: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ ...STORED })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ ...STORED, ...patch })),
    getSettingsRuntime: vi.fn(async () => ({ cpus: 12, automaticSuiteRuns: 6, suiteRunLimit: 6 })),
    getGitHubAccount: vi.fn(async () => ({ connected: false, reason: 'not_authenticated' })),
    signOutGitHub: vi.fn(async () => ({ signedOut: true })),
    getTelemetryConfig: vi.fn(async () => ({ telemetryEnabled: true, installationId: 'i' })),
    setTelemetryConfig: vi.fn(async (enabled: boolean) => ({ telemetryEnabled: enabled })),
  },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
// CGLAB-434: every test here also proves the panel renders on tokens.
guardTokens();

const renderPanel = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><SettingsPanel /></QueryClientProvider>);
};
const openVerification = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Verification/ }));
  return screen.findByRole('combobox', { name: /Suite runs at once/ });
};

describe('Settings: Verification', () => {
  it('offers Automatic, saying what it is on this machine, and 1 to the CPU count', async () => {
    renderPanel();
    const select = await openVerification();
    const options = [...(select as HTMLSelectElement).options].map(o => o.textContent);
    expect(options[0]).toMatch(/Automatic.*6/);
    expect(options.slice(1)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  });

  it('saves a number, server-wide', async () => {
    renderPanel();
    const select = await openVerification();
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('0'));
    fireEvent.change(select, { target: { value: '3' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ maxConcurrentSuiteRuns: 3 }));
  });

  it('saves Automatic as 0', async () => {
    renderPanel();
    const select = await openVerification();
    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.change(select, { target: { value: '0' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ maxConcurrentSuiteRuns: 0 }));
  });
});

describe('Settings: Account (CGLAB-434)', () => {
  it('renders the initials avatar of an account with no picture on tokens', async () => {
    vi.mocked(api.getGitHubAccount).mockResolvedValue({
      connected: true, login: 'leozin', name: 'Leonardo Rosa', email: null, avatarUrl: null,
    } as never);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Account$/ }));
    expect(await screen.findByText('LR')).toBeTruthy();
  });
});
