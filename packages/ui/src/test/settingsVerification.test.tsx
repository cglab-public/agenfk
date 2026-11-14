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
    projectSettings: vi.fn(async () => ({ rows: [
      { key: 'flow', label: 'Flow', description: 'Steps.', value: 'TDD', origin: 'set-here', from: 'Chosen.' },
      { key: 'verifyAtScope', label: 'Defer the suite to a parent in', description: 'How far a child reaches.', value: 'worktree', origin: 'inherited', from: 'From the flow.' },
      { key: 'exclusiveSuite', label: 'One suite run at a time', description: 'For suites sharing a database.', value: 'Off', origin: 'set-here', from: 'Set here.' },
    ] })),
    updateProject: vi.fn(async () => ({})),
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]),
    getAirlockPolicy: vi.fn(async () => ({ effective: { schemaVersion: 1, mode: 'off', models: [], appliesWhenModelUnknown: true, hosts: { allow: [], deny: [] }, iocHosts: { revision: '', hosts: [], updatedAt: null }, rules: { uploadToUnlistedHost: 'deny', credentialReadWithNetwork: 'deny', namespaceEscape: 'deny', cloudMutation: 'needs-human-approval' } }, source: 'local', revision: 0, hubManaged: false, local: null, hub: null })),
    getAirlockApprovals: vi.fn(async () => ({ pending: [], recent: [] })),
    getAirlockDecisions: vi.fn(async () => ({ decisions: [] })),
  },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
// CGLAB-434: every test here also proves the panel renders on tokens.
guardTokens();

const renderPanel = (projectId?: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><SettingsPanel projectId={projectId} /></QueryClientProvider>);
};
const openVerification = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Verification/ }));
  return screen.findByRole('combobox', { name: /Suite runs at once/ });
};

describe('Settings: Airlock (GH-294)', () => {
  it('opens on the section it is asked for, as `agenfk airlock edit` links it', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SettingsPanel initialSection="airlock" /></QueryClientProvider>);
    expect((await screen.findByRole('button', { name: /Airlock/ })).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Airlock');
  });
});

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

/*
 * 7ddeaf7c — the board in a browser has no project page, so the open project's
 * suite settings live here too: one panel, in both shells.
 */
describe('Settings: Project', () => {
  it('appears for the open project, with its two suite settings and nothing else of the project\'s', async () => {
    renderPanel('p1');
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    expect(await screen.findByTestId('setting-select-verifyAtScope')).toBeTruthy();
    expect(screen.getByTestId('setting-toggle-exclusiveSuite')).toBeTruthy();
    expect(screen.queryByTestId('setting-change-flow')).toBeNull();
    expect(api.projectSettings).toHaveBeenCalledWith('p1');
  });

  it('saves both through the project', async () => {
    renderPanel('p1');
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    fireEvent.change(await screen.findByTestId('setting-select-verifyAtScope'), { target: { value: 'project' } });
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('p1', { verifyAtScope: 'project' }));
    fireEvent.click(screen.getByTestId('setting-toggle-exclusiveSuite'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('p1', { exclusiveSuite: true }));
  });

  // CGLAB-670: its subtitle said "every project on this installation".
  it('says its settings apply only to the open project, by name', async () => {
    renderPanel('p1');
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    const header = (await screen.findByRole('heading', { name: 'Project' })).parentElement!;
    await waitFor(() => expect(header.textContent).toMatch(/These apply only to Alpha, the project open on the board\./));
    expect(header.textContent).not.toMatch(/every project/);
  });

  it('says the open project without a name when the project list has none for it', async () => {
    renderPanel('p9');
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    const header = (await screen.findByRole('heading', { name: 'Project' })).parentElement!;
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled());
    expect(header.textContent).toMatch(/These apply only to the project open on the board\./);
    expect(header.textContent).not.toMatch(/every project/);
  });

  it('says the open project without a name, and keeps its settings, when the project list cannot be read', async () => {
    vi.mocked(api.listProjects).mockRejectedValueOnce(new Error('down'));
    renderPanel('p1');
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    const header = (await screen.findByRole('heading', { name: 'Project' })).parentElement!;
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled());
    expect(header.textContent).toMatch(/These apply only to the project open on the board\./);
    expect(await screen.findByTestId('setting-toggle-exclusiveSuite')).toBeTruthy();
  });

  it('leaves the other sections saying they apply to every project', async () => {
    renderPanel('p1');
    fireEvent.click(await screen.findByRole('button', { name: /Verification/ }));
    const header = (await screen.findByRole('heading', { name: 'Verification' })).parentElement!;
    expect(header.textContent).toMatch(/These apply to every project on this installation\./);
  });

  it('is not offered with no project open', async () => {
    renderPanel();
    await screen.findByRole('button', { name: /Verification/ });
    expect(screen.queryByRole('button', { name: /^Project$/ })).toBeNull();
  });
});

// Review of 7ddeaf7c (Codex #7, #8).
describe('Settings: Project - saves that fail, and another project', () => {
  it('a save the server refuses puts the switch back and says it was not saved', async () => {
    vi.mocked(api.updateProject).mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { data: { error: 'exclusiveSuite must be true or false.' } } }));
    renderPanel('p1');
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    const toggle = await screen.findByTestId('setting-toggle-exclusiveSuite');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('setting-error-exclusiveSuite').textContent).toMatch(/Not saved/));
    expect(screen.getByTestId('setting-toggle-exclusiveSuite').getAttribute('aria-checked')).toBe('false');
  });

  it("opening another project shows that project's settings, not the last one's unsaved state", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // p2 first, so its rows are cached and drawn at once when it comes back - the case where a control is reused.
    const { rerender } = render(<QueryClientProvider client={qc}><SettingsPanel projectId="p2" /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /^Project$/ }));
    await screen.findByTestId('setting-toggle-exclusiveSuite');
    rerender(<QueryClientProvider client={qc}><SettingsPanel projectId="p1" /></QueryClientProvider>);
    await waitFor(() => expect(api.projectSettings).toHaveBeenCalledWith('p1'));
    fireEvent.click(await screen.findByTestId('setting-toggle-exclusiveSuite'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('p1', { exclusiveSuite: true }));
    rerender(<QueryClientProvider client={qc}><SettingsPanel projectId="p2" /></QueryClientProvider>);
    await waitFor(() => expect(api.projectSettings).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(screen.getByTestId('setting-toggle-exclusiveSuite').getAttribute('aria-checked')).toBe('false'));
  });
});
