/**
 * @vitest-environment node
 *
 * CGLAB-169: which agent CLIs are actually on this machine.
 *
 * Two traps here, and both have bitten this repo before.
 *
 * The first is PATH. A macOS app launched from Finder — which is how a packaged
 * app is normally launched — inherits a minimal PATH from launchd, NOT the one
 * a terminal gets. It does not contain `~/.local/bin`, Homebrew, nvm, asdf, or
 * anything a developer installed. So probing with the inherited PATH reports
 * "not installed" for CLIs the user demonstrably has, on their own machine,
 * while a terminal two inches away finds them. CGLAB-177 already hit this exact
 * shape when the run hook did not load as installed.
 *
 * The second is the closed set. Detection takes a name and asks the OS about
 * it. If that name could come from the renderer, detection becomes a probe
 * primitive — and then an execution one. Only ids already in agents.ts are ever
 * looked up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectAgents, __resetAgentDetectionCache, setAgentDetectionDeps, REAL_DETECTION_DEPS } from '../main/detectAgents';
import { AGENT_IDS, resolveAgentCommand } from '../main/agents';

/** A `which`-alike: resolves to a path for names the test says exist. */
const whichFinding = (...found: string[]) =>
  vi.fn(async (file: string) => (found.includes(file) ? `/usr/local/bin/${file}` : null));

beforeEach(() => __resetAgentDetectionCache());

describe('detecting installed agents', () => {
  it('marks an agent found on PATH as installed', async () => {
    const which = whichFinding('claude');
    const agents = await detectAgents({ which, loginPath: async () => null });
    expect(agents.find(a => a.id === 'claude-code')?.installed).toBe(true);
  });

  it('marks an agent that is not there as not installed', async () => {
    const which = whichFinding('claude');
    const agents = await detectAgents({ which, loginPath: async () => null });
    expect(agents.find(a => a.id === 'codex')?.installed).toBe(false);
  });

  it('reports every agent, installed or not', async () => {
    // The picker groups them; it cannot group what it was not told about. A
    // detector that returned only the installed ones would make "Not installed"
    // permanently empty and the user would never learn the others exist.
    const agents = await detectAgents({ which: whichFinding(), loginPath: async () => null });
    expect(agents.map(a => a.id)).toEqual([...AGENT_IDS]);
  });

  it('always counts the plain shell as available', async () => {
    // It is the fallback. Reporting it as missing would leave a user with no
    // CLI installed staring at an empty picker.
    const agents = await detectAgents({ which: whichFinding(), loginPath: async () => null });
    expect(agents.find(a => a.id === 'shell')?.installed).toBe(true);
  });

  it('probes the EXECUTABLE, not the agent id', async () => {
    // They are deliberately different: the id is 'claude-code' (the harness
    // vocabulary the server and hub already speak) while the binary on PATH is
    // `claude`. Probing the id reported Claude Code as not installed on a
    // machine that plainly had it, and offered an install command for
    // something already there.
    const which = whichFinding('claude');
    const agents = await detectAgents({ which, loginPath: async () => null });
    expect(agents.find(a => a.id === 'claude-code')?.installed).toBe(true);
  });

  it('only ever probes executables from the closed set', async () => {
    // Detection asks the OS about a name. If that name could come from the
    // renderer it is a probe primitive first and an execution one soon after.
    const which = whichFinding();
    await detectAgents({ which, loginPath: async () => null });
    const allowed = new Set(AGENT_IDS.map(id => resolveAgentCommand(id).file));
    for (const [name] of which.mock.calls) {
      expect(allowed, `probed "${name}", which no agent resolves to`).toContain(name);
    }
  });
});

describe('the Finder PATH problem', () => {
  it('falls back to a login shell PATH when the inherited one finds nothing', async () => {
    // The whole reason this is not a one-line `which`. An app opened from
    // Finder inherits launchd's PATH, which has none of ~/.local/bin, Homebrew,
    // nvm or asdf in it — so everything reports missing on a machine that
    // plainly has them.
    const which = vi.fn(async (file: string, pathOverride?: string) =>
      // `claude`, not `claude-code`: the probe asks about the EXECUTABLE,
      // which is deliberately a different string from the agent id.
      pathOverride?.includes('/Users/me/.local/bin') && file === 'claude'
        ? '/Users/me/.local/bin/claude'
        : null);
    const loginPath = vi.fn(async () => '/usr/bin:/Users/me/.local/bin');

    const agents = await detectAgents({ which, loginPath });
    expect(loginPath).toHaveBeenCalled();
    expect(agents.find(a => a.id === 'claude-code')?.installed).toBe(true);
  });

  it('does not pay for the login shell when the inherited PATH already works', async () => {
    // Spawning a login shell is slow and runs the user's rc files. Not worth
    // it when the answer is already in hand.
    const which = whichFinding(...AGENT_IDS.map(id => resolveAgentCommand(id).file));
    const loginPath = vi.fn(async () => '/usr/bin');
    await detectAgents({ which, loginPath });
    expect(loginPath).not.toHaveBeenCalled();
  });

  it('survives a login shell that fails or hangs', async () => {
    // A broken .zshrc must degrade detection, never wedge the picker.
    const agents = await detectAgents({
      which: whichFinding(),
      loginPath: async () => { throw new Error('rc file exploded'); },
    });
    expect(agents.length).toBe(AGENT_IDS.length);
    expect(agents.find(a => a.id === 'claude-code')?.installed).toBe(false);
  });
});

describe('how a binary is actually located', () => {
  it('does not try to execFile a shell builtin', async () => {
    // `command -v` is the idiomatic POSIX probe — inside a shell. `command` is
    // a builtin, not a file, so execFile('command', …) fails with ENOENT every
    // single time. An earlier version tried it first and fell through to
    // `which`, paying a failed spawn per probe for an answer it never gave.
    const { whichOnPath } = await import('../main/detectAgents');
    const found = await whichOnPath('sh');
    expect(found, 'could not locate `sh`, which exists on every POSIX machine').toBeTruthy();
  });

  it('reports nothing for a binary that does not exist', async () => {
    const { whichOnPath } = await import('../main/detectAgents');
    expect(await whichOnPath('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});

describe('caching', () => {
  it('does not re-probe on every picker open', async () => {
    const which = whichFinding('claude');
    await detectAgents({ which, loginPath: async () => null });
    const first = which.mock.calls.length;
    await detectAgents({ which, loginPath: async () => null });
    expect(which.mock.calls.length).toBe(first);
  });

  it('can be invalidated, so installing a CLI does not need an app restart', async () => {
    const before = whichFinding();
    await detectAgents({ which: before, loginPath: async () => null });

    __resetAgentDetectionCache();

    const after = whichFinding('codex');
    const agents = await detectAgents({ which: after, loginPath: async () => null });
    expect(agents.find(a => a.id === 'codex')?.installed).toBe(true);
  });

  it('does not cache a failed detection as a negative result forever', async () => {
    // If the first probe blew up, caching "nothing installed" would leave the
    // picker permanently wrong for the whole session.
    const exploding = vi.fn(async () => { throw new Error('spawn failed'); });
    await detectAgents({ which: exploding as never, loginPath: async () => null });

    const working = whichFinding('claude');
    const agents = await detectAgents({ which: working, loginPath: async () => null });
    expect(agents.find(a => a.id === 'claude-code')?.installed).toBe(true);
  });
});

describe('the shape that actually crosses the IPC border', () => {
  // The gap that let a whole feature ship dead. The unit tests above, and the
  // picker's tests on the renderer side, both hand-wrote their fixtures — so
  // both validated a shape the real producer never emitted. detectAgents
  // omitted supportsAutoApprove entirely, which made the toggle permanently
  // disabled AND made the dialog state, falsely, that Claude Code cannot skip
  // permissions.
  //
  // Two fixtures agreeing with each other prove nothing. This asserts the
  // producer against the contract the consumer is typed to.

  it('emits every field the preload declares', async () => {
    const agents = await detectAgents({ which: whichFinding('claude'), loginPath: async () => null });
    for (const agent of agents) {
      expect(Object.keys(agent).sort(), `agent "${agent.id}" is missing a field the renderer is typed to receive`)
        .toEqual(['id', 'installed', 'label', 'supportsAutoApprove']);
    }
  });

  it('reports auto-approve support truthfully, not as a constant', async () => {
    // Both branches, so a hardcoded `false` — which would also make every key
    // present — cannot pass.
    const agents = await detectAgents({ which: whichFinding('claude'), loginPath: async () => null });
    const byId = new Map(agents.map(a => [a.id, a]));
    expect(byId.get('claude-code')?.supportsAutoApprove).toBe(true);
    expect(byId.get('shell')?.supportsAutoApprove).toBe(false);
  });

  it('types every field, so nothing arrives as undefined', async () => {
    const agents = await detectAgents({ which: whichFinding(), loginPath: async () => null });
    for (const agent of agents) {
      expect(typeof agent.id).toBe('string');
      expect(typeof agent.label).toBe('string');
      expect(typeof agent.installed).toBe('boolean');
      expect(typeof agent.supportsAutoApprove).toBe('boolean');
    }
  });
});

describe('the guard against recursive capture', () => {
  it('refuses to spawn a login shell when it is already inside one', async () => {
    // Previously the guard was SET into the child and STRIPPED from the result
    // but never read, so the comment described a safeguard that did not exist —
    // and its only test asserted the constant was non-empty, which passed with
    // the mechanism entirely absent.
    const { captureLoginPath, LOGIN_CAPTURE_GUARD } = await import('../main/ptyEnv');
    process.env[LOGIN_CAPTURE_GUARD] = '1';
    try {
      expect(await captureLoginPath()).toBeNull();
    } finally {
      delete process.env[LOGIN_CAPTURE_GUARD];
    }
  });
});

/**
 * One login shell per boot, not two (CGLAB-181).
 *
 * `$SHELL -lic env` runs the user's whole rc chain — on a typical zsh with nvm
 * and oh-my-zsh that is 0.5-2s. The main process captured it once and the
 * comment there said detection and spawning shared the result. Spawning did.
 * Detection did not: every `detectAgents()` call with no deps fell through to
 * its own default and ran the capture again.
 *
 * WHEN it actually costs anything is the part worth writing down, because it
 * is the opposite of what it looks like in development: detection only reaches
 * for the login PATH when the cheap probe found NOTHING. In a terminal that
 * almost never happens, so the second capture is invisible. In the packaged
 * app it happens every time — launchd hands Electron a minimal PATH with no
 * agent on it, which is the whole reason the capture exists.
 */
describe('how often the login PATH is captured', () => {
  /*
   * `setAgentDetectionDeps` mutates module state, so it is put back. Without
   * this the file ends with the defaults pointing at the last fixture — fine
   * while every other test passes explicit deps, and a trap the moment one
   * does not, or the moment the suite runs shuffled.
   */
  afterEach(() => setAgentDetectionDeps(REAL_DETECTION_DEPS));

  /**
   * A machine as the packaged app sees it: nothing on the inherited PATH, the
   * agent reachable only once the login shell's PATH is known.
   */
  const launchdLikeDeps = () => {
    let calls = 0;
    return {
      calls: () => calls,
      deps: {
        which: async (file: string, pathOverride?: string) =>
          (pathOverride && file === 'claude' ? '/opt/homebrew/bin/claude' : null),
        loginPath: async () => { calls += 1; return '/opt/homebrew/bin:/usr/bin'; },
      },
    };
  };

  it('uses the deps the main process installed instead of its own default', async () => {
    // What this one really guards. The sequential case alone proved nothing
    // about the promise cache — the old RESULT cache produced the same count
    // here, because this detection succeeds and successes were cached.
    const { calls, deps } = launchdLikeDeps();
    setAgentDetectionDeps(deps);
    await detectAgents();
    await detectAgents();
    expect(calls()).toBe(1);
  });

  it('asks once when two callers arrive at the same time', async () => {
    // The window the result-cache left open: both see an empty cache, both run
    // a full detection, and that is two login shells. Caching the PROMISE is
    // what closes it. Reachable through StrictMode's double mount of the agent
    // picker, and through an `agents:list` overlapping an `agents:refresh` —
    // NOT, as an earlier version of this comment claimed, through the main
    // process warming detection at boot. Nothing warms it.
    const { calls, deps } = launchdLikeDeps();
    setAgentDetectionDeps(deps);
    await Promise.all([detectAgents(), detectAgents(), detectAgents()]);
    expect(calls()).toBe(1);
  });

  it('probes with the PATH the main process installed', async () => {
    // The defect itself: detection used to ignore what boot had already
    // captured and go get its own.
    const seen: string[] = [];
    setAgentDetectionDeps({
      which: async (file: string, pathOverride?: string) => {
        if (pathOverride) seen.push(pathOverride);
        return pathOverride && file === 'claude' ? '/installed/by/main/claude' : null;
      },
      loginPath: async () => '/installed/by/main',
    });
    await detectAgents();
    expect(seen).toContain('/installed/by/main');
  });

  it('does not remember a detection that found nothing', async () => {
    // The rule that predates the promise cache and had to survive it: a run
    // that found no CLI at all is far more likely a broken probe than a bare
    // machine, and remembering it leaves the picker wrong for the session.
    let captures = 0;
    setAgentDetectionDeps({
      which: async () => null,
      loginPath: async () => { captures += 1; return '/nothing/here'; },
    });
    await detectAgents();
    await detectAgents();
    expect(captures).toBe(2);
  });
});
