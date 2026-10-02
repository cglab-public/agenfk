/**
 * @vitest-environment node
 *
 * One place knows the operating system (card 2fd7c65c).
 *
 * On Windows "Open terminal" failed with `Error invoking remote method
 * 'pty:spawn': Error: File not found:` - the shell was `$SHELL || '/bin/sh'`,
 * Windows exports no SHELL, and node-pty cannot find /bin/sh there. The fix is
 * not one more `if (win32)`: the main process asked `process.platform` in seven
 * places, each with its own guess. A profile per OS is chosen once, and the
 * rest of the main process reads the profile.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { profileFor, platform, accountShell } from '../main/platform';
import { resolveShellCommand, resolveAgentCommand } from '../main/agents';
import { loginShell } from '../main/ptyEnv';

const MAIN_DIR = path.resolve(__dirname, '../main');

describe('the Windows profile', () => {
  const win = profileFor('win32');
  const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  // By absolute path: node-pty's ConPTY lookup searches the app's own Path by
  // exact name, not the pty's env, and a miss is the bare "File not found: ".
  it('opens PowerShell by absolute path, with no Unix fallback', () => {
    expect(win.shell({})).toEqual({ file: POWERSHELL, args: [] });
  });

  it('finds PowerShell under the SystemRoot Windows reports', () => {
    expect(win.shell({ SystemRoot: 'D:\\WINDOWS' }).file).toBe('D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('ignores a POSIX $SHELL inherited from Git Bash, which node-pty cannot find on Windows', () => {
    expect(win.shell({ SHELL: '/usr/bin/bash' })).toEqual({ file: POWERSHELL, args: [] });
  });

  it('starts the Shell agent without -l, which powershell.exe does not accept', () => {
    expect(win.shellAgent({}, null)).toEqual({ file: POWERSHELL, args: [] });
  });

  it('has no login shell to capture a PATH from, and looks commands up with where', () => {
    expect(win.capturesLoginPath).toBe(false);
    expect(win.pathLookup).toBe('where');
  });

  it('keeps the default title bar, quits with its last window, and has no dock', () => {
    expect(win.titleBarStyle).toBe('default');
    expect(win.quitsWhenAllWindowsClosed).toBe(true);
    expect(win.hasDock).toBe(false);
  });
});

describe('the macOS profile', () => {
  const mac = profileFor('darwin');

  it('opens the user\'s $SHELL, then the account\'s shell, then /bin/sh', () => {
    expect(mac.shell({ SHELL: '/bin/zsh' }, '/bin/bash')).toEqual({ file: '/bin/zsh', args: [] });
    // A GUI launch that exported no SHELL still knows the account's shell.
    expect(mac.shell({}, '/opt/homebrew/bin/fish')).toEqual({ file: '/opt/homebrew/bin/fish', args: [] });
    expect(mac.shell({}, null)).toEqual({ file: '/bin/sh', args: [] });
  });

  // card df675f82: it was `bash -l` whatever the user ran - nothing at all
  // where there is no bash, and a bash for everyone on zsh or fish.
  it('starts the Shell agent as the user\'s own shell, as a login shell', () => {
    expect(mac.shellAgent({ SHELL: '/bin/zsh' }, null)).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(mac.shellAgent({ SHELL: '/opt/homebrew/bin/fish' }, '/bin/zsh')).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'] });
    expect(mac.shellAgent({}, null)).toEqual({ file: '/bin/sh', args: ['-l'] });
  });

  it('passes -l only to a shell known to take it: elvish refuses it, an unknown shell opens without', () => {
    expect(mac.shellAgent({ SHELL: '/usr/local/bin/elvish' }, null)).toEqual({ file: '/usr/local/bin/elvish', args: [] });
    expect(mac.shellAgent({ SHELL: '/opt/bin/someshell' }, null).args).toEqual([]);
  });

  it('skips an account shell that is a refusal - nologin or false - for /bin/sh', () => {
    // A service account in a container: no SHELL exported, passwd says nologin.
    for (const account of ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']) {
      expect(mac.shell({}, account)).toEqual({ file: '/bin/sh', args: [] });
      expect(mac.shellAgent({}, account)).toEqual({ file: '/bin/sh', args: ['-l'] });
    }
  });

  it('captures the login PATH and looks commands up with which', () => {
    expect(mac.capturesLoginPath).toBe(true);
    expect(mac.pathLookup).toBe('which');
  });

  it('insets the title bar, stays open with no windows, and has a dock', () => {
    expect(mac.titleBarStyle).toBe('hiddenInset');
    expect(mac.quitsWhenAllWindowsClosed).toBe(false);
    expect(mac.hasDock).toBe(true);
  });
});

describe('the Linux profile', () => {
  const linux = profileFor('linux');

  it('is a Unix: the user\'s shell, as a login shell for the Shell agent, login PATH, which', () => {
    expect(linux.shell({ SHELL: '/usr/bin/fish' }, null)).toEqual({ file: '/usr/bin/fish', args: [] });
    expect(linux.shell({}, null)).toEqual({ file: '/bin/sh', args: [] });
    // Alpine and other minimal systems ship no bash; /bin/sh is always there.
    expect(linux.shellAgent({}, null)).toEqual({ file: '/bin/sh', args: ['-l'] });
    expect(linux.shellAgent({}, '/bin/ash')).toEqual({ file: '/bin/ash', args: ['-l'] });
    expect(linux.capturesLoginPath).toBe(true);
    expect(linux.pathLookup).toBe('which');
  });

  it('has the window behaviour of every platform that is not macOS', () => {
    expect(linux.titleBarStyle).toBe('default');
    expect(linux.quitsWhenAllWindowsClosed).toBe(true);
    expect(linux.hasDock).toBe(false);
  });

  it('is what an unlisted Unix gets', () => {
    expect(profileFor('freebsd')).toEqual(linux);
  });
});

describe('the profile in use', () => {
  it('is the one for the platform the app is running on', () => {
    expect(platform).toEqual(profileFor(process.platform));
  });

  it('is what opens the shell', () => {
    expect(resolveShellCommand()).toEqual(platform.shell(process.env, accountShell()));
  });

  it('gives the terminal, the Shell agent and the login PATH capture the same shell', () => {
    // Three places used to choose a shell three ways (/bin/sh, bash, /bin/bash).
    expect(resolveAgentCommand('shell', {}).file).toBe(resolveShellCommand().file);
    expect(loginShell()).toBe(resolveShellCommand().file);
  });

  it('reads the account\'s shell as null where there is no passwd entry', async () => {
    // os.userInfo() throws for a uid with no entry (some containers).
    vi.resetModules();
    vi.doMock('os', async importOriginal => ({
      ...(await importOriginal<typeof import('os')>()),
      userInfo: () => { throw new Error('uid 1001 has no passwd entry'); },
    }));
    try {
      const fresh = await import('../main/platform');
      expect(fresh.accountShell()).toBeNull();
    } finally {
      vi.doUnmock('os');
      vi.resetModules();
    }
  });

  it('is the only thing in the main process that asks which OS this is', () => {
    const ASKS_THE_OS = new RegExp([
      String.raw`process\.platform`, String.raw`process\[\s*['"]platform['"]\s*\]`,
      String.raw`\{[^}]*\bplatform\b[^}]*\}\s*=\s*process\b(?!\s*\.)`,
      String.raw`\bos\.(platform|type)\(`, String.raw`require\(\s*['"](node:)?os['"]\s*\)\.(platform|type)\b`,
      // `type` is left to os.type( above: `import { type X } from 'os'` is a type import.
      String.raw`import\s*\{[^}]*\bplatform\b[^}]*\}\s*from\s*['"](node:)?os['"]`,
      String.raw`process\.env\.OS\b`,
    ].join('|'));
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const offenders = walk(MAIN_DIR)
      .filter(f => f.endsWith('.ts') && f !== path.join(MAIN_DIR, 'platform.ts'))
      .flatMap(f => fs.readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (ASKS_THE_OS.test(line) ? `${path.relative(MAIN_DIR, f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null));
    expect(offenders, `read the profile from ./platform instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
