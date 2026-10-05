/**
 * @vitest-environment jsdom
 *
 * Reaching the desktop host from the renderer, including when it is not there.
 *
 * These tests existed inside the terminal-dialog suite and were nearly lost
 * when that dialog stopped asking about persistence. The dialog went away; the
 * code they guard did not, and it guards a real crash rather than a nicety.
 *
 * The renderer bundle and the preload ship as SEPARATE artifacts and can be
 * mismatched after an upgrade: an older preload exposes `terminal` without the
 * newer methods. Calling one blind threw a TypeError that took the entire
 * settings screen down — the user could not change any setting at all because
 * of one method that only draws a warning label.
 *
 * That the CURRENT preload exposes everything is guarded elsewhere, at the
 * source, by packages/desktop/src/test/ipcSurface.test.ts comparing the
 * handler list to the preload. This file covers the other case: a host that is
 * older, or absent entirely.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { listAgentsFromBridge, sessionPersistenceFromBridge } from '../components/agentBridge';

const setHost = (terminal: unknown): void => {
  (window as unknown as Record<string, unknown>).agenfkDesktop = { terminal };
};

afterEach(() => { delete (window as unknown as Record<string, unknown>).agenfkDesktop; });

describe('when there is no host at all', () => {
  it('reports no agents rather than throwing', async () => {
    // A browser tab. There are no local CLIs to offer a page, and that is an
    // answer rather than an error.
    await expect(listAgentsFromBridge()).resolves.toEqual([]);
  });

  it('reports no persistence, which is the literal truth', async () => {
    // Not a fallback: a page has no process to keep alive once the tab is gone.
    await expect(sessionPersistenceFromBridge()).resolves.toEqual({ available: false });
  });
});

describe('when the host is older than this bundle', () => {
  it('reads "no persistence" from a preload that has no such method', async () => {
    // The crash this prevents. `?.` is not enough — the object is there, the
    // method is not — so the check is on the method itself.
    setHost({ listAgents: async () => [] });
    await expect(sessionPersistenceFromBridge()).resolves.toEqual({ available: false });
  });

  it('still uses the methods the old preload DOES have', async () => {
    // Degrading must be per-method. Treating one missing method as "this host
    // is unusable" would disable agent detection too, and the user would be
    // told nothing is installed.
    setHost({ listAgents: async () => [{ id: 'pi', label: 'Pi', installed: true, supportsAutoApprove: false }] });
    await expect(listAgentsFromBridge()).resolves.toHaveLength(1);
  });
});

describe('when the host is current', () => {
  it('passes the answer through untouched', async () => {
    setHost({
      listAgents: async () => [],
      sessionPersistence: async () => ({ available: false, warning: 'tmux_unsupported_on_windows' }),
    });
    await expect(sessionPersistenceFromBridge()).resolves.toEqual({
      available: false, warning: 'tmux_unsupported_on_windows',
    });
  });
});
