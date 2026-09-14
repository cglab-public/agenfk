/**
 * @vitest-environment node
 *
 * Which hook event actually ends a run (BUG be7805e6).
 *
 * The hook closed the run on `Stop` as well as `SessionEnd`, and its comment
 * said "The session ended". It had the wrong event. `Stop` is a PER-TURN hook:
 * the Claude Code binary describes it as one that can block "the turn from
 * ending" and passes `stop_hook_active` so a hook can tell it is being called
 * again within the same turn. It fires every time the assistant finishes
 * answering, with the session very much alive.
 *
 * The damage is not cosmetic. Closing the run also drops the cache entry, so
 * the next tool call opens a BRAND NEW AgentRun with a new id — one session
 * becomes dozens of runs. Anything reading `status` to mean "this session
 * finished" is then wrong once per turn, which is precisely what the sessions
 * rail was rebuilt to rely on.
 *
 * Orphans are the reason `Stop` looked attractive: if `SessionEnd` never
 * arrives — a crash, a `kill -9` — the run stays `running` forever. That case
 * is real and is handled where it belongs, by the launch-time rule in
 * liveSessions.ts, rather than by declaring every turn boundary a death.
 */
import { describe, it, expect } from 'vitest';
import { closesRun } from '../../../../bin/agenfk-run-hook.mjs';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

describe('the events that end a run', () => {
  it('ends on SessionEnd, which is the one that means it', () => {
    expect(closesRun('SessionEnd')).toBe(true);
  });

  it('does NOT end on Stop, which only means the turn ended', () => {
    /*
     * The whole bug in one line. With this true, a session that answers and
     * waits for its human is recorded as finished, its run is closed, and its
     * next tool call starts a different run.
     */
    expect(closesRun('Stop')).toBe(false);
  });

  it('does not end on SubagentStop either', () => {
    // A sub-agent finishing is even further from the session ending — the
    // parent is mid-turn by definition.
    expect(closesRun('SubagentStop')).toBe(false);
  });

  it('does not end on the events that record work', () => {
    // These carry the tool calls. Treating one as a close would end the run at
    // its first recorded action.
    expect(closesRun('PreToolUse')).toBe(false);
    expect(closesRun('PostToolUse')).toBe(false);
  });

  it('does not end on an event it has never heard of', () => {
    /*
     * Hook events get added. The safe default for an unknown one is "this is
     * not a death": leaving a run open too long is visible and recoverable,
     * while closing it early loses the rest of the session's history with no
     * symptom at all.
     */
    expect(closesRun('SomethingAddedLater')).toBe(false);
    expect(closesRun('')).toBe(false);
    expect(closesRun(undefined)).toBe(false);
  });
});

/**
 * And that the installer subscribes to the right one.
 *
 * `closesRun` is only half the fix. The hook can only close on an event it is
 * actually invoked for, and the installer registered the run hook under `Stop`
 * — so the `SessionEnd` branch was unreachable code and the per-turn close was
 * the only behaviour that ever ran.
 *
 * A source-level guard rather than a real install, deliberately: running the
 * installer writes into the developer's own client configuration. It reads the
 * file the way the shipped installer would be read, so a revert fails it.
 */
describe('how the installer subscribes', () => {
  const source = (): string => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return fs.readFileSync(path.resolve(here, '../../../../scripts/install.mjs'), 'utf8');
  };

  it('registers the run hook on SessionEnd', () => {
    expect(source()).toContain('settings.hooks.SessionEnd.push');
  });

  it('never registers it on Stop again', () => {
    // The regression in one assertion. Pushing the hook onto `Stop` is what
    // closed a live session's run once per turn.
    expect(source()).not.toContain('settings.hooks.Stop.push');
  });

  it('removes a Stop registration left by an older install', () => {
    /*
     * Upgrades matter more than fresh installs here. Anyone who installed
     * before this fix has the hook written into their settings.json under
     * `Stop`, and adding the SessionEnd entry beside it would leave BOTH
     * firing — the per-turn close intact, now with a correct one next to it.
     */
    const s = source();
    const at = s.indexOf('settings.hooks.SessionEnd.push');
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at)).toMatch(/settings\.hooks\.Stop\s*=\s*settings\.hooks\.Stop\.filter/);
  });
});
