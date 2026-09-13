/**
 * @vitest-environment node
 *
 * CGLAB-169: the environment a terminal is born into.
 *
 * This is the least visible part of the whole subsystem and the one that breaks
 * the most. Nothing throws and nothing logs — the agent's interface simply
 * renders in the wrong colours, or the launch fails with ENOENT for a binary
 * the user demonstrably has. The symptom points at the agent, never at us.
 *
 * Two independent problems live here:
 *
 *  - TERM. A main process launched from Finder has no TERM at all, so node-pty
 *    falls back to plain `xterm`: no 256 colours, no truecolor. Every agent TUI
 *    draws degraded, on every machine, always.
 *  - PATH. That same process inherits launchd's minimal PATH, which contains
 *    none of ~/.local/bin, Homebrew, nvm, asdf or mise. Detection already
 *    recovers a usable PATH from a login shell — and then the spawn used the
 *    minimal one anyway, so the picker could say "installed" and launching
 *    could still fail.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildPtyEnv, mergePath, LOGIN_CAPTURE_GUARD, parseEnvDump } from '../main/ptyEnv';

describe('the terminal type', () => {
  it('declares 256 colours instead of letting node-pty fall back to plain xterm', () => {
    // The single highest-value assertion in this file. Without it every agent
    // TUI renders in a degraded palette and the obvious suspect is the agent.
    expect(buildPtyEnv({}).TERM).toBe('xterm-256color');
  });

  it('declares truecolor', () => {
    expect(buildPtyEnv({}).COLORTERM).toBe('truecolor');
  });

  it('identifies itself, so a tool can adapt to running inside the app', () => {
    expect(buildPtyEnv({}).TERM_PROGRAM).toBe('agenfk');
  });

  it('overrides an inherited TERM rather than trusting it', () => {
    // An inherited TERM comes from whatever launched the app — a dumb terminal
    // in a CI shell, or `dumb` from an editor. We know what we render.
    expect(buildPtyEnv({ TERM: 'dumb' }).TERM).toBe('xterm-256color');
  });
});

describe('what must not leak into a spawned agent', () => {
  it('strips the variables that say "you are inside Electron"', () => {
    // An agent that shells out to node would otherwise inherit
    // ELECTRON_RUN_AS_NODE and re-enter our own binary instead of node.
    const env = buildPtyEnv({
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_IS_DEV: '1',
      PATH: '/usr/bin',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_IS_DEV).toBeUndefined();
  });

  it('strips build-tool noise that describes how WE were launched', () => {
    const env = buildPtyEnv({
      npm_lifecycle_event: 'dev',
      npm_config_registry: 'https://x',
      VITE_FOO: '1',
      NODE_ENV: 'development',
    });
    expect(env.npm_lifecycle_event).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.VITE_FOO).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
  });

  it('strips the vitest markers, or a spawned agent thinks it is under test', () => {
    const env = buildPtyEnv({ VITEST: 'true', VITEST_WORKER_ID: '3' });
    expect(env.VITEST).toBeUndefined();
    expect(env.VITEST_WORKER_ID).toBeUndefined();
  });

  it('keeps everything else the user had', () => {
    // Stripping is a named list, not a whitelist: a developer's own exports are
    // exactly what makes their tools work.
    const env = buildPtyEnv({ HOME: '/Users/me', LANG: 'pt_BR.UTF-8', MY_TOKEN: 'x' });
    expect(env.HOME).toBe('/Users/me');
    expect(env.LANG).toBe('pt_BR.UTF-8');
    expect(env.MY_TOKEN).toBe('x');
  });

  it('gives HOME a value rather than leaving a shell without one', () => {
    expect(buildPtyEnv({}).HOME).toBeTruthy();
  });
});

describe('merging a login shell PATH', () => {
  it('puts the recovered entries first', () => {
    // They are the ones the inherited PATH is missing.
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin'))
      .toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('keeps inherited entries that the login shell did not have', () => {
    // Merge, not replace. Something the app was launched with may genuinely be
    // needed, and dropping it trades one missing-binary bug for another.
    expect(mergePath('/opt/homebrew/bin', '/usr/bin:/special/tool'))
      .toBe('/opt/homebrew/bin:/usr/bin:/special/tool');
  });

  it('does not duplicate an entry present in both', () => {
    expect(mergePath('/usr/bin:/bin', '/bin:/usr/bin').split(':').filter(p => p === '/bin'))
      .toHaveLength(1);
  });

  it('drops empty segments rather than producing "::"', () => {
    // An empty PATH segment means "the current directory" to some shells,
    // which is a real hazard in a directory an agent is writing to.
    expect(mergePath('/usr/bin::', ':/bin:').split(':').filter(p => p === '')).toHaveLength(0);
  });

  it('survives either side being empty or missing', () => {
    expect(mergePath('', '/usr/bin')).toBe('/usr/bin');
    expect(mergePath('/usr/bin', '')).toBe('/usr/bin');
    expect(mergePath(null, null)).toBe('');
  });
});

describe('capturing that PATH without recursing', () => {
  // The guard's real behaviour is asserted in detectAgents.test.ts, where the
  // capture can be driven. What lived here was `expect(LOGIN_CAPTURE_GUARD)
  // .toBeTruthy()` — which passed while the guard was never read at all, and
  // so certified a safeguard that did not exist.
  it('is stripped from the captured result, being our own marker', () => {
    const parsed = parseEnvDump(`${LOGIN_CAPTURE_GUARD}=1\nPATH=/usr/bin\n`);
    expect(parsed[LOGIN_CAPTURE_GUARD]).toBeUndefined();
    expect(parsed.PATH).toBe('/usr/bin');
  });

  it('reads an env dump into a map', () => {
    const parsed = parseEnvDump('PATH=/usr/bin:/bin\nHOME=/Users/me\nEMPTY=\n');
    expect(parsed.PATH).toBe('/usr/bin:/bin');
    expect(parsed.HOME).toBe('/Users/me');
    expect(parsed.EMPTY).toBe('');
  });

  it('keeps values that themselves contain "="', () => {
    // Base64 secrets, connection strings and JWTs all end in padding or carry
    // separators. Splitting on every '=' truncates them.
    const parsed = parseEnvDump('TOKEN=abc=def==\n');
    expect(parsed.TOKEN).toBe('abc=def==');
  });

  it('ignores lines that are not assignments', () => {
    // A login shell prints banners, motd and rc-file chatter before env output.
    const parsed = parseEnvDump('Welcome back!\nPATH=/usr/bin\n-- some banner --\n');
    expect(parsed.PATH).toBe('/usr/bin');
    expect(Object.keys(parsed)).toEqual(['PATH']);
  });

  it('drops the guard from the captured result', () => {
    // It is our own marker; leaking it into every spawned agent is noise.
    const parsed = parseEnvDump(`${LOGIN_CAPTURE_GUARD}=1\nPATH=/usr/bin\n`);
    expect(parsed[LOGIN_CAPTURE_GUARD]).toBeUndefined();
  });
});
