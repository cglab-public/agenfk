/**
 * @vitest-environment node
 *
 * INFRA-425: terminals in WSL, from the Windows app.
 *
 * The Windows build renders far better than the Linux one under WSLg, and it
 * adopts the server running in WSL. What it could not do was open the work:
 * every terminal was PowerShell, and a card's worktree is a Linux path
 * (/home/...) that PowerShell cannot even `cd` into.
 *
 * So on Windows a terminal can run inside a WSL distro, through wsl.exe:
 *
 *   - always, when its directory is a Linux path (there is no other way in);
 *   - for everything, when the person chose a distro in Settings.
 *
 * The part this file is strictest about is the command line. A card's text
 * becomes an argument to the agent, and that text crosses wsl.exe into a
 * shell. It must arrive as ONE positional argument to a fixed exec line —
 * never spliced into a string a shell parses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseDistroList,
  isLinuxPath,
  chooseWslTarget,
  wslLaunch,
  withWslEnv,
  wslExecutable,
  windowsCommandLine,
  parseProbe,
  WSL_LOGIN_EXEC,
  WSL_PROBE_SCRIPT,
} from '../main/wsl';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { detectAgents, __resetAgentDetectionCache } from '../main/detectAgents';
import { PtyRegistry } from '../main/ptyRegistry';

const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

/*
 * CommandLineToArgvW, the reader wsl.exe uses for what follows `--exec`,
 * written out so the round trip can be asserted on any OS. The rules are
 * Microsoft's "Parsing C++ command-line arguments", post-2008 behaviour.
 */
function commandLineToArgv(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i += 1;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '\\') {
        let n = 0;
        while (line[i] === '\\') { n += 1; i += 1; }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          if (n % 2 === 1) { arg += '"'; continue; }
          i -= 1;
          continue;
        }
        arg += '\\'.repeat(n);
        i -= 1;
        continue;
      }
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { arg += '"'; i += 1; continue; }
        quoted = !quoted;
        continue;
      }
      if (!quoted && (ch === ' ' || ch === '\t')) break;
      arg += ch;
    }
    out.push(arg);
  }
  return out;
}

/** What a spawn was given, read back the way Windows would split it. */
const argvOf = (args: readonly string[] | string): readonly string[] =>
  (typeof args === 'string' ? commandLineToArgv(args) : args);

describe('reading the installed distros', () => {
  it('decodes what wsl.exe prints, which is UTF-16 with CRLF and a BOM', () => {
    expect(parseDistroList(utf16('\uFEFFUbuntu\r\nDebian\r\n\r\n'))).toEqual(['Ubuntu', 'Debian']);
  });

  it('keeps names with dots and dashes intact', () => {
    expect(parseDistroList(utf16('Ubuntu-26.04\r\n'))).toEqual(['Ubuntu-26.04']);
  });

  it('answers nothing for empty output', () => {
    expect(parseDistroList(Buffer.alloc(0))).toEqual([]);
  });

  it('drops the engines that register as distros', () => {
    const listed = 'Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nrancher-desktop\r\npodman-machine-default\r\n';
    expect(parseDistroList(utf16(listed))).toEqual(['Ubuntu']);
  });

  it('reads UTF-8 too, which wsl.exe prints when WSL_UTF8=1 is set', () => {
    expect(parseDistroList(Buffer.from('Ubuntu\r\nDebian\r\n', 'utf8'))).toEqual(['Ubuntu', 'Debian']);
  });

  it('keeps only names WSL itself allows, so nothing else reaches --distribution', () => {
    expect(parseDistroList(utf16('Ubuntu\r\n-help\r\nThis is not a name\r\n'))).toEqual(['Ubuntu']);
  });
});

describe('which directories only WSL can open', () => {
  it('treats an absolute POSIX path as Linux', () => {
    expect(isLinuxPath('/home/eduardopin/dev/repo')).toBe(true);
  });

  it('treats drive and UNC paths as Windows', () => {
    expect(isLinuxPath('C:\\Users\\e\\repo')).toBe(false);
    expect(isLinuxPath('\\\\server\\share')).toBe(false);
    expect(isLinuxPath('relative/path')).toBe(false);
  });
});

describe('deciding where a terminal runs', () => {
  const base = { onWindows: true, distros: ['Ubuntu', 'Debian'], running: [] as string[], preference: '' };

  it('never uses WSL off Windows', () => {
    expect(chooseWslTarget({ ...base, onWindows: false, cwd: '/home/e/repo' })).toBeNull();
  });

  it('keeps a Windows directory on Windows when no distro was chosen', () => {
    expect(chooseWslTarget({ ...base, cwd: 'C:\\Users\\e' })).toBeNull();
  });

  it('sends a Linux directory to WSL even when no distro was chosen, to wsl.exe\'s own default', () => {
    // No name: wsl.exe knows its default, and the list is not needed for it.
    expect(chooseWslTarget({ ...base, cwd: '/home/e/repo' })).toEqual({ distro: null });
  });

  it('names the only running distro, so a Linux path lands where the server is', () => {
    expect(chooseWslTarget({ ...base, running: ['Debian'], cwd: '/home/e/repo' })).toEqual({ distro: 'Debian' });
  });

  it('falls back to wsl.exe\'s default when none, or several, are running', () => {
    expect(chooseWslTarget({ ...base, running: [], cwd: '/home/e/repo' })).toEqual({ distro: null });
    expect(chooseWslTarget({ ...base, running: ['Ubuntu', 'Debian'], cwd: '/home/e/repo' })).toEqual({ distro: null });
  });

  it('keeps a Windows directory on Windows even with one distro running and no choice', () => {
    expect(chooseWslTarget({ ...base, running: ['Debian'], cwd: 'C:\\Users\\e' })).toBeNull();
  });

  it('prefers the chosen distro over the running one', () => {
    expect(chooseWslTarget({ ...base, running: ['Debian'], preference: 'Ubuntu', cwd: '/home/e/repo' })).toEqual({ distro: 'Ubuntu' });
  });

  it('uses the chosen distro for everything once one is chosen', () => {
    expect(chooseWslTarget({ ...base, preference: 'Debian', cwd: 'C:\\Users\\e' })).toEqual({ distro: 'Debian' });
    expect(chooseWslTarget({ ...base, preference: 'Debian', cwd: '/home/e/repo' })).toEqual({ distro: 'Debian' });
  });

  it('ignores a stored distro that is no longer installed', () => {
    expect(chooseWslTarget({ ...base, preference: 'Arch', cwd: 'C:\\Users\\e' })).toBeNull();
    expect(chooseWslTarget({ ...base, preference: 'Arch', cwd: '/home/e/repo' })).toEqual({ distro: null });
  });

  it('still opens a Linux directory when the distro list could not be read (a cold VM)', () => {
    expect(chooseWslTarget({ ...base, distros: [], preference: 'Debian', cwd: '/home/e/repo' })).toEqual({ distro: null });
  });
});

describe('the wsl.exe command line', () => {
  it('opens the login shell in the directory for a plain terminal', () => {
    expect(wslLaunch({ distro: 'Ubuntu', cwd: '/home/e/repo' })).toMatchObject({
      file: 'wsl.exe',
      args: ['--distribution', 'Ubuntu', '--cd', '/home/e/repo'],
    });
  });

  it('leaves --distribution off for the default distro', () => {
    expect(wslLaunch({ distro: null, cwd: '/home/e/repo' }).args).toEqual(['--cd', '/home/e/repo']);
  });

  it('opens the Linux home for a terminal that belongs to no directory', () => {
    expect(wslLaunch({ distro: 'Ubuntu', cwd: null }).args).toEqual(['--distribution', 'Ubuntu', '--cd', '~']);
  });

  it('runs wsl.exe by absolute path from System32', () => {
    expect(wslExecutable({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\wsl.exe');
    expect(wslLaunch({ distro: null, cwd: null, exe: 'X:\\wsl.exe' }).file).toBe('X:\\wsl.exe');
  });

  it('runs an agent through a fixed script, with its argv as positional arguments', () => {
    const prompt = 'Fix the "parser"; then `rm -rf ~` $(whoami)';
    const launched = wslLaunch({
      distro: 'Ubuntu',
      cwd: '/home/e/wt',
      command: { file: 'claude', args: ['--session-id', 'abc', prompt] },
    });
    expect(launched.args).toEqual([
      '--distribution', 'Ubuntu', '--cd', '/home/e/wt',
      '--exec', '/bin/sh', '-c', WSL_LOGIN_EXEC, 'agenfk-wsl',
      'claude', '--session-id', 'abc', prompt,
    ]);
    // The prompt is never part of the string a shell parses.
    expect(WSL_LOGIN_EXEC).not.toContain('claude');
    expect(launched.args.filter(a => a.includes('rm -rf'))).toEqual([prompt]);
  });

  it('starts the agent through the person\'s own login shell, replacing it', () => {
    expect(WSL_LOGIN_EXEC).toContain('getent passwd');
    expect(WSL_LOGIN_EXEC).toContain(`-lic 'exec "$0" "$@"'`);
    // Any shell that is not bash or zsh gets POSIX sh, which reads ~/.profile.
    expect(WSL_LOGIN_EXEC).toContain(`exec /bin/sh -lc 'exec "$0" "$@"'`);
  });
});

describe('the Windows command line', () => {
  const hard = [
    'plain',
    'two words',
    '"Fix the parser" then "x"',
    'ends with a backslash\\',
    'C:\\path with space\\',
    'quote \\" after a backslash',
    '',
    'line one\nline two',
    '$(whoami) `id` ; & | <>',
  ];

  it('reads back as exactly the arguments it was built from', () => {
    expect(commandLineToArgv(windowsCommandLine(hard))).toEqual(hard);
  });

  it('is what wslLaunch hands the spawner, for the login script and the prompt alike', () => {
    const launched = wslLaunch({ distro: 'Ubuntu', cwd: '/home/e', command: { file: 'claude', args: ['"quoted" prompt'] } });
    expect(commandLineToArgv(launched.commandLine)).toEqual(launched.args);
  });
});

describe('the environment that crosses into WSL', () => {
  it('forwards the terminal type, which wsl.exe drops otherwise', () => {
    const env = withWslEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'agenfk' });
    expect(env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['TERM/u', 'COLORTERM/u', 'TERM_PROGRAM/u']));
  });

  it('keeps whatever WSLENV already carried', () => {
    const env = withWslEnv({ WSLENV: 'USERPROFILE/p', TERM: 'xterm-256color' });
    expect(env.WSLENV?.split(':')).toContain('USERPROFILE/p');
  });

  it('does not list a variable twice', () => {
    const env = withWslEnv({ WSLENV: 'TERM/u', TERM: 'xterm-256color' });
    expect(env.WSLENV?.split(':').filter(v => v.startsWith('TERM/'))).toHaveLength(1);
  });
});

describe('a registry that knows about WSL', () => {
  let spawned: Array<{ file: string; args: readonly string[]; cwd: string }>;
  const spawn = vi.fn((file: string, args: readonly string[] | string, opts: { cwd: string }) => {
    spawned.push({ file, args: args as readonly string[], cwd: opts.cwd });
    return {
      pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {},
      pause: () => {}, resume: () => {},
    };
  });

  let asked: string[];
  let located: string[];
  const registryWith = (target: { distro: string | null } | null) => new PtyRegistry({
    spawn: spawn as never,
    resolveCwd: async () => ({ cwd: '/home/e/.agenfk-worktrees/repo/feat-x', branchName: 'feat/x' }),
    emit: () => {},
    locate: async (file: string) => { located.push(file); return null; },
    wslTarget: async ({ cwd }) => { asked.push(cwd); return target; },
  });

  beforeEach(() => { spawned = []; asked = []; located = []; spawn.mockClear(); });

  it('runs a card terminal inside the distro, in the card worktree', async () => {
    await registryWith({ distro: 'Ubuntu' })
      .spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
    expect(asked).toEqual(['/home/e/.agenfk-worktrees/repo/feat-x']);
    expect(path.win32.basename(spawned[0].file)).toBe('wsl.exe');
    expect(argvOf(spawned[0].args).slice(0, 4)).toEqual(['--distribution', 'Ubuntu', '--cd', '/home/e/.agenfk-worktrees/repo/feat-x']);
    expect(argvOf(spawned[0].args)).toContain('claude');
    // The pty itself starts somewhere Windows can open; the Linux directory is
    // wsl.exe's business.
    expect(spawned[0].cwd).toBe(os.homedir());
    // Inside the distro the agent is found by its login shell, not on Windows.
    expect(located).toEqual([]);
  });

  it('opens a plain shell as the distro login shell', async () => {
    await registryWith({ distro: 'Ubuntu' })
      .spawn({ agentId: 'shell', windowId: 1, cols: 80, rows: 24 } as never);
    expect(argvOf(spawned[0].args)).toEqual(['--distribution', 'Ubuntu', '--cd', '~']);
  });

  it('opens the Shell agent on a card as the login shell in the worktree, not PowerShell inside Linux', async () => {
    await registryWith({ distro: null })
      .spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    expect(argvOf(spawned[0].args)).toEqual(['--cd', '/home/e/.agenfk-worktrees/repo/feat-x']);
  });

  it('spawns exactly as before when there is no WSL target', async () => {
    await registryWith(null).spawn({ itemId: 'i1', agentId: 'shell', windowId: 1, cols: 80, rows: 24 });
    expect(spawned[0].file).not.toMatch(/wsl\.exe$/);
    expect(spawned[0].cwd).toBe('/home/e/.agenfk-worktrees/repo/feat-x');
  });
});

describe('the probe that asks the distro which agents it has', () => {
  // Run for real under POSIX sh: the bug this guards was an exit status.
  it.skipIf(process.platform === 'win32')('answers with what it found even when the LAST name is missing', () => {
    const out = execFileSync('/bin/sh', ['-c', WSL_PROBE_SCRIPT, 'probe', 'sh', 'agenfk-no-such-agent'], { encoding: 'utf8' });
    expect(parseProbe(out, ['sh', 'agenfk-no-such-agent'])).toEqual(new Set(['sh']));
  });

  it('keeps only names that were asked for, whatever an rc file printed', () => {
    expect(parseProbe('Welcome to Ubuntu\r\nclaude\r\npi\n', ['claude', 'codex', 'pi'])).toEqual(new Set(['claude', 'pi']));
  });
});

describe('detecting agents when terminals run in WSL', () => {
  const deps = (onWindows: string[], inLinux: string[], exclusive: boolean) => ({
    which: async (file: string) => (onWindows.includes(file) ? `C:\\bin\\${file}.exe` : null),
    loginPath: async () => null,
    inWsl: async () => ({ found: new Set(inLinux), exclusive }),
  });
  const installed = async (d: ReturnType<typeof deps>) => {
    __resetAgentDetectionCache();
    return new Map((await detectAgents(d)).map(a => [a.id, a.installed]));
  };

  it('counts an agent that exists only inside the distro', async () => {
    const got = await installed(deps([], ['pi'], false));
    expect(got.get('pi')).toBe(true);
    expect(got.get('codex')).toBe(false);
  });

  it('counts only the distro once every terminal runs there', async () => {
    // Installed on Windows alone, it would die inside Linux with "not found".
    const got = await installed(deps(['claude'], ['pi'], true));
    expect(got.get('claude-code')).toBe(false);
    expect(got.get('pi')).toBe(true);
  });

  it('falls back to Windows alone when the distro cannot be asked', async () => {
    __resetAgentDetectionCache();
    const got = new Map((await detectAgents({ ...deps(['claude'], [], false), inWsl: async () => null })).map(a => [a.id, a.installed]));
    expect(got.get('claude-code')).toBe(true);
  });
});

describe('choosing the distro in Settings', () => {
  // Imported here so the describes above stay readable without IPC plumbing.
  type Handler = (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown> | string[]>;
  let handlers: Record<string, Handler>;
  let dir: string;

  beforeEach(async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { registerPtyIpc } = await import('../main/ptyIpc');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-wsl-prefs-'));
    handlers = {};
    const registry = { spawn: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), ack: vi.fn() } as never;
    registerPtyIpc(registry, {
      handle: (channel, listener) => {
        handlers[channel] = (ev, ...args) => Promise.resolve().then(() => (listener as never as Handler)(ev, ...args));
      },
    }, () => ({ available: false }), () => dir,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { distros: async () => ['Ubuntu', 'Debian'] });
  });

  it('lists the installed distros for the picker', async () => {
    expect(await handlers['wsl:distros']({})).toEqual(['Ubuntu', 'Debian']);
  });

  it('starts with nobody having chosen one', async () => {
    expect((await handlers['prefs:get']({}) as Record<string, unknown>).wslDistro).toBe('');
  });

  it('stores an installed distro, and clears back to Windows with an empty string', async () => {
    expect((await handlers['prefs:set']({}, { key: 'wslDistro', value: 'Debian' }) as Record<string, unknown>).wslDistro)
      .toBe('Debian');
    expect((await handlers['prefs:set']({}, { key: 'wslDistro', value: '' }) as Record<string, unknown>).wslDistro)
      .toBe('');
  });

  it('accepts only the empty choice where there is no WSL at all', async () => {
    const { registerPtyIpc } = await import('../main/ptyIpc');
    const bare: Record<string, Handler> = {};
    registerPtyIpc({ spawn: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), ack: vi.fn() } as never, {
      handle: (channel, listener) => {
        bare[channel] = (ev, ...args) => Promise.resolve().then(() => (listener as never as Handler)(ev, ...args));
      },
    }, () => ({ available: false }), () => dir);
    await expect(bare['prefs:set']({}, { key: 'wslDistro', value: 'Ubuntu' })).rejects.toThrow(/wslDistro/);
    expect((await bare['prefs:set']({}, { key: 'wslDistro', value: '' }) as Record<string, unknown>).wslDistro).toBe('');
    expect(await bare['wsl:distros']({})).toEqual([]);
  });

  it('refuses a name that is not an installed distro', async () => {
    // The renderer picks from a list; it never names one. A name that is not
    // installed would be passed to `wsl.exe --distribution`.
    for (const bad of ['Arch', '--help', 'Ubuntu; calc.exe', 7, null]) {
      await expect(handlers['prefs:set']({}, { key: 'wslDistro', value: bad })).rejects.toThrow(/wslDistro/);
    }
  });
});
