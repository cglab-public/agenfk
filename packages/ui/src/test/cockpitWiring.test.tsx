/**
 * @vitest-environment jsdom
 *
 * INFRA-425: the cockpit reaches the terminal header.
 *
 * The pane asks main for its session's cockpit (only it knows the session id),
 * only while it is on screen, and reports up; the tab renders the gadgets for
 * the terminal on screen, honouring the toggles in Settings.
 */
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Terminal } from '@xterm/xterm';
import { TerminalPane } from '../components/TerminalPane';
import { writeCockpitToggle, readCockpitToggles, onCockpitTogglesChanged } from '../cockpitPrefs';

const paneProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));

describe('the pane asks for its cockpit', () => {
  const originalRects = HTMLElement.prototype.getClientRects;
  const setShown = (shown: boolean) => {
    HTMLElement.prototype.getClientRects = function rects() { return (shown ? [{}] : []) as unknown as DOMRectList; };
  };
  beforeEach(() => { vi.useFakeTimers(); setShown(true); });
  afterEach(() => { cleanup(); vi.useRealTimers(); HTMLElement.prototype.getClientRects = originalRects; });

  const fakeTerm = () => new Proxy({ options: {}, cols: 80, rows: 24, loadAddon: () => {} } as Record<string, unknown>, {
    get: (t, prop: string) => (prop in t ? t[prop] : () => ({ dispose: () => {} })),
  }) as unknown as Terminal;

  const mount = (cockpit: ReturnType<typeof vi.fn>, onCockpit = vi.fn()) => {
    const bridge = {
      spawn: vi.fn(async () => ({ sessionId: 'sess-1' })),
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(async () => {}),
      onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
      cockpit,
    };
    render(<TerminalPane itemId="i1" agentId="shell" bridge={bridge as never} onCockpit={onCockpit}
      createTerminal={() => fakeTerm()}
      createFitAddon={() => ({ activate: () => {}, dispose: () => {}, fit: () => {} })}
      createRendererAddon={() => null} />);
    return onCockpit;
  };

  it('asks with its own session id once the session exists, and reports the answer', async () => {
    const snap = { git: { branch: 'main', dirty: false, ahead: 0, behind: 0 } };
    const cockpit = vi.fn(async () => snap);
    const onCockpit = mount(cockpit);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1500); await Promise.resolve(); await Promise.resolve(); });
    expect(cockpit).toHaveBeenCalledWith('sess-1');
    expect(onCockpit).toHaveBeenCalledWith(snap);
    await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
    expect(cockpit).toHaveBeenCalledTimes(2);
  });

  it('does not run a probe nobody sees, and does once the pane is shown', async () => {
    setShown(false);
    const cockpit = vi.fn(async () => ({}));
    mount(cockpit);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(16_500); await Promise.resolve(); });
    expect(cockpit).not.toHaveBeenCalled();
    // The control: the same pane, now on screen, asks at the next refresh.
    setShown(true);
    await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
    expect(cockpit).toHaveBeenCalledWith('sess-1');
  });

  it('stops asking once main says the session is gone', async () => {
    const cockpit = vi.fn(async () => { throw new Error('Unknown session.'); });
    mount(cockpit);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1500); await Promise.resolve(); await Promise.resolve(); });
    expect(cockpit).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(45_000); await Promise.resolve(); });
    expect(cockpit).toHaveBeenCalledTimes(1);
  });
});

describe('the header shows it', () => {
  beforeEach(() => { localStorage.clear(); paneProps.last = null; });
  afterEach(() => { cleanup(); vi.doUnmock('../components/TerminalPane'); vi.resetModules(); });

  const renderTab = async () => {
    vi.resetModules();
    vi.doMock('../components/TerminalPane', () => ({
      TerminalPane: (props: Record<string, unknown>) => { paneProps.last = props; return null; },
    }));
    vi.doMock('../api', () => ({ api: { getGitStatus: vi.fn(async () => ({ changed: 0, staged: 0, files: [] })) } }));
    const { TerminalTab } = await import('../components/TerminalTab');
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TerminalTab
          sessions={[{ id: 's1', itemId: 'i1', title: 'A card', agentId: 'claude-code', autoApprove: false, persist: false, openedAt: new Date().toISOString(), branchName: 'feat/x' }]}
          activeId="s1" onSelect={vi.fn()} onClose={vi.fn()} onNew={vi.fn()}
        />
      </QueryClientProvider>,
    );
  };

  const report = (snap: Record<string, unknown>) =>
    act(() => { (paneProps.last!.onCockpit as (s: unknown) => void)(snap); });

  it('renders the gadgets and lets the cockpit\'s branch replace the chip', async () => {
    await renderTab();
    expect(screen.getByTestId('session-branch')).toBeInTheDocument();
    report({ git: { branch: 'feat/x', dirty: true, ahead: 1, behind: 0 }, aws: { profile: 'cglab-prod-ro', expires: null } });
    expect(screen.getByTestId('cockpit-git').textContent).toContain('feat/x* ↑1');
    expect(screen.getByTestId('cockpit-aws').className).toContain('danger');
    expect(screen.queryByTestId('session-branch')).toBeNull();
  });

  it('marks a profile from the shell\'s start environment with a ? that explains why', async () => {
    await renderTab();
    report({ aws: { profile: 'cglab-stg', expires: null, source: 'shell' } });
    expect(screen.getByTestId('cockpit-aws-caveat').getAttribute('title')).toMatch(/export/);
    report({ aws: { profile: 'cglab-stg', expires: null, source: 'reported' } });
    expect(screen.queryByTestId('cockpit-aws-caveat')).toBeNull();
  });

  it('hides a gadget switched off in Settings, and brings the chip back for git', async () => {
    await renderTab();
    report({ git: { branch: 'feat/x', dirty: false, ahead: 0, behind: 0 }, tf: 'stg' });
    act(() => { writeCockpitToggle('git', false); });
    await waitFor(() => expect(screen.queryByTestId('cockpit-git')).toBeNull());
    expect(screen.getByTestId('cockpit-tf')).toBeInTheDocument();
    expect(screen.getByTestId('session-branch')).toBeInTheDocument();
  });
});

describe('the toggles', () => {
  beforeEach(() => localStorage.clear());

  it('start with everything on and remember a change', () => {
    expect(Object.values(readCockpitToggles()).every(Boolean)).toBe(true);
    writeCockpitToggle('cost', false);
    expect(readCockpitToggles().cost).toBe(false);
    expect(readCockpitToggles().git).toBe(true);
  });

  it('tell other windows: a storage event re-reads them', () => {
    const seen = vi.fn();
    const off = onCockpitTogglesChanged(seen);
    window.dispatchEvent(new StorageEvent('storage', { key: 'agenfk.cockpitGadgets' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    off();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('survive storage that cannot be read', () => {
    localStorage.setItem('agenfk.cockpitGadgets', 'not json');
    expect(readCockpitToggles().aws).toBe(true);
  });
});
