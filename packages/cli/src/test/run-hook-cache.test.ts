/**
 * @vitest-environment node
 *
 * The hook's run cache, and letting go of a run the server no longer has.
 *
 * The cache maps a session to the AgentRun it opened, so every tool call after
 * the first posts to the same run instead of opening a new one. What it had no
 * way to do was let go: if the run disappeared server-side — a reset database,
 * a restored backup — every subsequent event POSTed to a run that does not
 * exist, got a 404, and was discarded. The session then recorded nothing at
 * all for the rest of its life, SILENTLY, which is the part that matters.
 *
 * These helpers were untestable until now for a mundane reason: the file
 * started a watchdog and exited the process on import, so a test that imported
 * it killed its own runner. It only runs that when invoked as a hook now.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Statically imported: a variable specifier cannot be resolved at build time,
// and importing it at all is only safe because the file no longer starts a
// watchdog and exits the process unless it was INVOKED as a hook.
//
// RUN_MAP lands under the per-run sandbox HOME the test config pins, never the
// developer's real ~/.agenfk — that pinning is why this is safe to touch.
import * as hook from '../../../../bin/agenfk-run-hook.mjs';

const wipe = (): void => {
  try { fs.rmSync(hook.RUN_MAP, { force: true }); } catch { /* nothing to wipe */ }
};
beforeEach(wipe);
afterEach(wipe);

describe('remembering a run', () => {
  it('reads back what it wrote', () => {
    hook.rememberRun('sess::item', 'run-1');
    expect(hook.readRunMap()['sess::item']).toBe('run-1');
  });

  it('keeps other sessions when one is written', () => {
    hook.rememberRun('a::1', 'run-a');
    hook.rememberRun('b::2', 'run-b');
    expect(hook.readRunMap()).toMatchObject({ 'a::1': 'run-a', 'b::2': 'run-b' });
  });
});

describe('forgetting a run the server no longer has', () => {
  it('drops only that entry', () => {
    // The failure this prevents: the entry lives forever, every later event
    // 404s, and the session stops recording with nothing surfacing.
    hook.rememberRun('gone::1', 'run-gone');
    hook.rememberRun('fine::2', 'run-fine');
    hook.forgetRun('gone::1');
    const map = hook.readRunMap();
    expect(map['gone::1']).toBeUndefined();
    expect(map['fine::2']).toBe('run-fine');
  });

  it('is harmless for a key that was never there', () => {
    hook.rememberRun('fine::2', 'run-fine');
    hook.forgetRun('never-existed');
    expect(hook.readRunMap()['fine::2']).toBe('run-fine');
  });

  it('survives a cache file that is not readable JSON', () => {
    // A half-written file, which the write-then-rename exists to avoid but
    // which an older version could still have left behind. Throwing here would
    // fail the tool call the hook is running inside.
    fs.mkdirSync(path.dirname(hook.RUN_MAP), { recursive: true });
    fs.writeFileSync(hook.RUN_MAP, '{ not json');
    expect(() => hook.forgetRun('anything')).not.toThrow();
  });

  it('leaves no cache file behind when there was none', () => {
    expect(() => hook.forgetRun('anything')).not.toThrow();
  });
});
