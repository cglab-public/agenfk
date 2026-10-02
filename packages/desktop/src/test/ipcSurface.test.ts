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

/**
 * Channels the preload SUBSCRIBES to, through the demux.
 *
 * A separate reader because the demux took these out of the old one's sight:
 * they are no longer arguments to `ipcRenderer.on`, they are arguments to
 * `demux.on`. The regex above stopped matching them and nothing failed, which
 * is precisely the drift this file exists to catch.
 */
const preloadSubscriptions = (): string[] => {
  const src = read('preload/index.ts');
  return [...src.matchAll(/demux\.on\(\s*'([^']+)'/g)].map(m => m[1]).sort();
};

/**
 * Channels the main process PUSHES, read from the registry's emit calls.
 *
 * These were never guarded at all. The old exemption below named two of them
 * and let them through, so renaming `pty:activity` on either side left the
 * whole suite green and agent state silently dead — the exact "producer and
 * consumer agreeing with nobody" failure this file's header describes.
 */
const emittedChannels = (): string[] => {
  const src = read('main/ptyRegistry.ts');
  return [...new Set([...src.matchAll(/emit\([^,]+,\s*'([^']+)'/g)].map(m => m[1]))].sort();
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
    /*
     * Push channels are excluded by SOURCE now, not by name. The old version
     * listed two of them as string prefixes, which quietly stopped being
     * exhaustive the day a third was added and became dead code entirely once
     * the demux moved them out of this reader's sight.
     */
    const pushed = new Set(emittedChannels());
    const dangling = preloadChannels().filter(c => !pushed.has(c) && !registeredChannels().includes(c));
    expect(dangling, 'the preload calls channels no handler serves').toEqual([]);
  });
});

/**
 * The push channels, which had no guard at all.
 *
 * `invoke`/`handle` pairs were covered from the start; the channels main
 * pushes to the renderer were exempted by name and never checked. Renaming
 * one on either side breaks agent state or terminal output in production and
 * nothing anywhere goes red.
 */
describe('what main pushes is what the renderer listens for', () => {
  it('finds channels on both sides, so a broken regex fails loudly', () => {
    // The same protection the reader above has. Two empty lists would make
    // every assertion here pass while checking nothing.
    expect(emittedChannels().length).toBeGreaterThan(0);
    expect(preloadSubscriptions().length).toBeGreaterThan(0);
  });

  it('subscribes to every channel main emits', () => {
    // A channel nobody listens for is output that never reaches a terminal,
    // or an exit that never closes a tab.
    const unheard = emittedChannels().filter(c => !preloadSubscriptions().includes(c));
    expect(unheard, 'main emits these and the preload listens to none of them').toEqual([]);
  });

  it('listens for nothing main does not emit', () => {
    // The mirror: a subscription to a renamed channel is a feature that went
    // silently dead.
    const unheard = preloadSubscriptions().filter(c => !emittedChannels().includes(c));
    expect(unheard, 'the preload waits for channels nothing sends').toEqual([]);
  });
});
