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

  it('looks commands up with where, and separates PATH entries with ;', () => {
    expect(win.pathLookup).toBe('where');
    expect(win.pathDelimiter).toBe(';');
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

  it('looks commands up with which, and separates PATH entries with :', () => {
    expect(mac.pathLookup).toBe('which');
    expect(mac.pathDelimiter).toBe(':');
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
    expect(linux.pathLookup).toBe('which');
    expect(linux.pathDelimiter).toBe(':');
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

/*
 * Where an agent is, and how to open it (story 1b9d622e).
 *
 * The picker said "Not installed" for a Claude Code the person had just
 * installed from PowerShell, and on a Mac whose terminal found it. The fix is
 * not a list of install locations - npm, brew, nvm, volta, scoop, a native
 * installer all end on the PATH a fresh terminal gets. So each profile says how
 * to obtain THAT PATH, the same way it already says which shell to open.
 */
describe('the PATH a fresh terminal would have', () => {
  it('is the user\'s login shell\'s environment on a Unix', () => {
    const mac = profileFor('darwin');
    expect(mac.freshPath.command({ SHELL: '/bin/zsh' }, null)).toEqual({ file: '/bin/zsh', args: ['-lic', 'env'] });
    expect(mac.freshPath.output).toBe('env');
    expect(profileFor('linux').freshPath.command({}, '/usr/bin/fish')).toEqual({ file: '/usr/bin/fish', args: ['-lic', 'env'] });
  });

  it('is read from the machine and user settings on Windows, which a running app never sees change', () => {
    // A GUI process keeps the environment it was started with. Installing
    // Claude Code with the app open - the reported case - changes the user's
    // Path in the registry, and only a NEW process reads it.
    const win = profileFor('win32');
    const { file, args } = win.freshPath.command({ SystemRoot: 'C:\\Windows' }, null);
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toContain('-NoProfile');
    const script = args[args.length - 1];
    expect(script).toContain("GetEnvironmentVariable('Path','Machine')");
    expect(script).toContain("GetEnvironmentVariable('Path','User')");
    // PowerShell 5.1 writes to a pipe in the console code page; a profile
    // folder named João would arrive mangled when read as UTF-8.
    expect(script.indexOf('[Console]::OutputEncoding')).toBe(0);
    expect(win.freshPath.output).toBe('path');
  });
});

describe('choosing what `where` / `which` found', () => {
  it('takes the first line on a Unix', () => {
    expect(profileFor('darwin').pickExecutable(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])).toBe('/opt/homebrew/bin/claude');
    expect(profileFor('linux').pickExecutable([])).toBeNull();
  });

  it('skips the extensionless sh script npm also writes on Windows, which nothing there can run', () => {
    // `npm i -g` drops claude (a sh script), claude.cmd and claude.ps1 side by
    // side, and `where claude` lists the bare one first.
    const win = profileFor('win32');
    expect(win.pickExecutable([
      'C:\\Users\\Carlos Roberto\\AppData\\Roaming\\npm\\claude',
      'C:\\Users\\Carlos Roberto\\AppData\\Roaming\\npm\\claude.cmd',
    ])).toBe('C:\\Users\\Carlos Roberto\\AppData\\Roaming\\npm\\claude.cmd');
    expect(win.pickExecutable(['C:\\Users\\c\\.local\\bin\\claude.exe'])).toBe('C:\\Users\\c\\.local\\bin\\claude.exe');
    expect(win.pickExecutable(['C:\\x\\claude', 'C:\\x\\claude.ps1'])).toBeNull();
  });
});

describe('opening what was found', () => {
  it('runs the resolved path directly on a Unix', () => {
    expect(profileFor('darwin').launch('/opt/homebrew/bin/claude', ['--resume', 'x'], {}))
      .toEqual({ file: '/opt/homebrew/bin/claude', args: ['--resume', 'x'] });
  });

  it('runs an .exe directly on Windows', () => {
    expect(profileFor('win32').launch('C:\\Users\\c\\.local\\bin\\claude.exe', ['-p', 'hi'], {}))
      .toEqual({ file: 'C:\\Users\\c\\.local\\bin\\claude.exe', args: ['-p', 'hi'] });
  });

  it('runs a .cmd through cmd.exe, because ConPTY cannot start a script', () => {
    const cmd = profileFor('win32').launch('C:\\npm\\claude.cmd', ['--resume', 'abc'], { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(cmd.file).toBe('C:\\Windows\\system32\\cmd.exe');
    // Escaped twice: once for cmd's own parse, once for the batch file's
    // re-parse of %* (see the injection test below).
    expect(cmd.commandLine).toBe('/d /v:off /s /c "C:\\npm\\claude.cmd ^^^"--resume^^^" ^^^"abc^^^""');
  });

  it('falls back to cmd.exe under SystemRoot when ComSpec is unset', () => {
    expect(profileFor('win32').launch('C:\\npm\\claude.CMD', [], { SystemRoot: 'D:\\WIN' }).file).toBe('D:\\WIN\\System32\\cmd.exe');
  });

  it('keeps a multi-line prompt whole through cmd.exe, which ends the command at a line break', () => {
    // A card's text has paragraphs. cmd.exe stops reading at the first line
    // break, so everything after it - and the closing quote - would be lost.
    const { commandLine } = profileFor('win32').launch('C:\\npm\\claude.cmd', ['first line\r\nsecond\nthird'], {});
    expect(commandLine).not.toMatch(/[\r\n]/);
    expect(commandLine).toContain('first^^^ line^^^ second^^^ third');
  });

  /*
   * cmd.exe's special-character phase, as far as it decides what runs: a "
   * toggles quoting, ^ outside quotes takes the next character literally, and
   * an unquoted & | < > ends the command. Returns the text it passes on and
   * whether anything outside the first command would have run.
   */
  const cmdPhase = (line: string): { text: string; injected: boolean } => {
    let text = '';
    let quoted = false;
    let injected = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (!quoted && c === '^' && i + 1 < line.length) { text += line[++i]; continue; }
      if (c === '"') quoted = !quoted;
      else if (!quoted && '&|<>'.includes(c)) injected = true;
      text += c;
    }
    return { text, injected };
  };

  /** How the program itself splits its command line (MSVC rules), enough for quoted arguments. */
  const msvcSplit = (line: string): string[] => {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
      while (line[i] === ' ') i++;
      if (i >= line.length) break;
      let arg = '';
      let quoted = false;
      for (; i < line.length && (quoted || line[i] !== ' '); i++) {
        let slashes = 0;
        while (line[i] === '\\') { slashes++; i++; }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2) arg += '"'; else quoted = !quoted;
        } else {
          arg += '\\'.repeat(slashes);
          if (i < line.length) arg += line[i]; else break;
        }
      }
      out.push(arg);
    }
    return out;
  };

  it('starts cmd.exe with delayed expansion OFF, whatever the registry says', () => {
    // With it on (a registry setting some machines carry), a line holding !
    // gets one more caret-removal pass, which undoes the escaping below.
    const { commandLine } = profileFor('win32').launch('C:\\npm\\claude.cmd', ['x'], {});
    expect(commandLine!.startsWith('/d /v:off /s /c "')).toBe(true);
  });

  it('keeps a card prompt from running a second command, through BOTH parses of an npm shim', () => {
    // The first prompt is the card's own text - free text, imported from JIRA
    // or GitHub as often as typed. cmd parses `/c "<line>"` once; npm's shim
    // then runs `"%_prog%" "...cli.js" %*`, and cmd parses that line AGAIN.
    // Escaped once, a quote in the prompt closes a quoted run in the second
    // parse and `& calc` runs (the BatBadBut class).
    const hostile = ['please fix" & calc & "', 'a | b', 'x" > out.txt "', '^&^|', '%PATH% & echo', 'fix!" & calc & "', '!PATH!', 'end\\', 'C:\\dir\\ "q"'];
    for (const prompt of hostile) {
      const { commandLine } = profileFor('win32').launch('C:\\Program Files\\npm\\claude.cmd', [prompt], {});
      const first = cmdPhase(commandLine!.slice('/d /v:off /s /c "'.length, -1));
      expect(first.injected, `first parse of ${JSON.stringify(prompt)}`).toBe(false);
      const args = first.text.slice(first.text.indexOf('claude.cmd ') + 'claude.cmd '.length);
      const second = cmdPhase(`"C:\\node.exe" "C:\\npm\\cli.js" ${args}`);
      expect(second.injected, `second parse of ${JSON.stringify(prompt)}`).toBe(false);
      // And the agent receives exactly the prompt - not over- or under-escaped.
      expect(msvcSplit(second.text).slice(2), `round trip of ${JSON.stringify(prompt)}`).toEqual([prompt]);
    }
  });
});
