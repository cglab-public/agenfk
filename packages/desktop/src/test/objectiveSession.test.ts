/**
 * A session that belongs to an OBJECTIVE, not to a card.
 *
 * Ask AgEnFK opens an agent on a sentence, before any card exists — producing
 * one first is exactly what that screen avoids. `spawn` required an itemId, so
 * this is the boundary being crossed, and these are the four things that must
 * stay true while crossing it.
 */
import { describe, it, expect, vi } from 'vitest';
import { PtyRegistry } from '../main/ptyRegistry';

/** The registry's own dependency name is `spawn`; the fake is the same shape
 *  the existing registry spec uses. */
const fakePty = () => ({
  pid: 1, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(),
  kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
});

const deps = (over: Record<string, unknown> = {}) => ({
  spawn: vi.fn(() => fakePty()),
  resolveCwd: vi.fn(async () => ({ cwd: '/worktree/for/card', branchName: 'feat/x' })),
  resolveProjectCwd: vi.fn(async () => ({ cwd: '/checkout/of/project' })),
  registerRun: vi.fn(),
  emit: vi.fn(),
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  itemId: '', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24, ...over,
});

describe('a session on an objective', () => {
  it('runs in the project checkout, not in a card worktree', async () => {
    const d = deps();
    const registry = new PtyRegistry(d as never);
    await registry.spawn(request({ projectId: 'p1' }) as never);
    expect(d.resolveProjectCwd).toHaveBeenCalledWith('p1');
    // Cutting a worktree would mean creating the card this screen proposes.
    expect(d.resolveCwd).not.toHaveBeenCalled();
  });

  it('registers no run, because a run belongs to a card', async () => {
    const d = deps();
    await new PtyRegistry(d as never).spawn(request({ projectId: 'p1' }) as never);
    expect(d.registerRun).not.toHaveBeenCalled();
  });

  it('still registers a run for a card session', async () => {
    // The other half: nothing about the new path may switch the old one off.
    const d = deps();
    await new PtyRegistry(d as never).spawn(request({ itemId: 'i1' }) as never);
    expect(d.registerRun).toHaveBeenCalled();
    expect(d.resolveCwd).toHaveBeenCalledWith('i1');
  });

  it('refuses when the build cannot resolve a project', async () => {
    // An older main process exposes no resolveProjectCwd. Spawning anyway
    // would put the agent in whatever directory the app happened to start in.
    const d = deps({ resolveProjectCwd: undefined });
    await expect(new PtyRegistry(d as never).spawn(request({ projectId: 'p1' }) as never))
      .rejects.toThrow(/objective/i);
  });
});
