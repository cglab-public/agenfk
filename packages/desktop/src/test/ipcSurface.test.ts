/**
 * @vitest-environment node
 *
 * Every channel the main process registers must be reachable.
 *
 * This exists because the same defect happened twice in one day, and neither
 * time did any test notice.
 *
 * First `supportsAutoApprove` was computed in the main process and dropped on
 * the way out of `detectAgents`, so the renderer's toggle was permanently dead
 * and the dialog told the user, falsely, that Claude Code could not skip
 * permissions. Then `sessions:persistence` was registered in `ptyIpc` and never
 * added to the preload, so the channel could not be called at all — the whole
 * "does this session survive quitting" signal was built and unreachable.
 *
 * Both are the same shape: a producer and a consumer written separately, each
 * tested against its own fixture, agreeing with nobody. A channel with no way
 * to call it is worse than a missing feature, because the code looks finished.
 *
 * So this test reads both SOURCES — the registration and the preload — and
 * requires they describe the same surface.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');

const registeredChannels = (): string[] => {
  const src = read('main/ptyIpc.ts');
  return [...src.matchAll(/ipc\.handle\(\s*'([^']+)'/g)].map(m => m[1]).sort();
};

const preloadChannels = (): string[] => {
  const src = read('preload/index.ts');
  return [...src.matchAll(/ipcRenderer\.(?:invoke|on|off)\(\s*'([^']+)'/g)].map(m => m[1]);
};

describe('the IPC surface is reachable from the renderer', () => {
  it('registers at least one channel, so a broken regex fails loudly', () => {
    // Both sides are read with regular expressions. If one silently matched
    // nothing, every assertion below would pass on two empty lists.
    expect(registeredChannels().length).toBeGreaterThan(0);
    expect(preloadChannels().length).toBeGreaterThan(0);
  });

  it('exposes every channel the main process handles', () => {
    // The failure this is here for. `sessions:persistence` was registered and
    // never exposed, so the renderer could not call it and nothing said so.
    const unreachable = registeredChannels().filter(c => !preloadChannels().includes(c));
    expect(
      unreachable,
      'these channels are handled in main but nothing in the preload can call them',
    ).toEqual([]);
  });

  it('does not invoke channels nothing handles', () => {
    // The mirror image: a preload method calling a channel that was renamed or
    // removed fails at runtime, in the user's hands, with no compile error.
    const dangling = preloadChannels().filter(c => {
      // Events pushed FROM main are not registered with ipc.handle.
      if (c.startsWith('pty:data') || c.startsWith('pty:exit')) return false;
      return !registeredChannels().includes(c);
    });
    expect(dangling, 'the preload calls channels no handler serves').toEqual([]);
  });
});
