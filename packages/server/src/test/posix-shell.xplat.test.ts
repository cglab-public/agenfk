/**
 * @file GitHub #208 phase 2 — the shell server specs run their git fixtures in.
 *
 * About fifty server specs build throwaway git repos with one shell string
 * (`git init -q -b main && git config ... && echo a > a && git commit -qm one`)
 * run under a hard-coded `/bin/sh`. Native Node on Windows has no `/bin/sh`, so all
 * of them died with `spawnSync /bin/sh ENOENT` before asserting anything
 * (635 tests). Git for Windows — which AgEnFK already requires — ships a POSIX
 * `sh.exe`, so `posixShell()` names that one on win32 and `/bin/sh` elsewhere:
 * the fixtures keep their exact shell semantics on every OS.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { posixBash, posixShell, shellQuote } from './helpers/posixShell';

describe('posixShell()', () => {
  it('is /bin/sh off Windows, without asking git', () => {
    const gitExecPath = () => { throw new Error('must not be called'); };
    expect(posixShell({ platform: 'linux', gitExecPath, exists: () => false })).toBe('/bin/sh');
    expect(posixShell({ platform: 'darwin', gitExecPath, exists: () => false })).toBe('/bin/sh');
  });

  it("is Git for Windows' bin/sh.exe on win32, found from git --exec-path", () => {
    const seen: string[] = [];
    const sh = posixShell({
      platform: 'win32',
      gitExecPath: () => 'C:/Program Files/Git/ucrt64/libexec/git-core\n',
      exists: (p) => { seen.push(p); return p === path.win32.join('C:/Program Files/Git', 'bin', 'sh.exe'); },
    });
    expect(sh).toBe(path.win32.join('C:/Program Files/Git', 'bin', 'sh.exe'));
    expect(seen[0]).toBe(sh);
  });

  it('falls back to usr/bin/sh.exe when bin/sh.exe is missing', () => {
    const sh = posixShell({
      platform: 'win32',
      gitExecPath: () => 'D:\\tools\\Git\\mingw64\\libexec\\git-core',
      exists: (p) => p === path.win32.join('D:\\tools\\Git', 'usr', 'bin', 'sh.exe'),
    });
    expect(sh).toBe(path.win32.join('D:\\tools\\Git', 'usr', 'bin', 'sh.exe'));
  });

  it('says what is missing when Git for Windows has no sh.exe', () => {
    expect(() => posixShell({
      platform: 'win32',
      gitExecPath: () => 'C:/Git/mingw64/libexec/git-core',
      exists: () => false,
    })).toThrow(/sh\.exe.*Git for Windows/);
  });

  describe('on this machine', () => {
    let dir = '';
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); dir = ''; });

    it('runs a git fixture string with POSIX semantics', () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-posix-shell-'));
      execSync(
        'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm "one two"',
        { cwd: dir, shell: posixShell(), windowsHide: true },
      );
      const log = execSync("git log --format='%s' -1", { cwd: dir, shell: posixShell(), encoding: 'utf8', windowsHide: true });
      expect(log.trim()).toBe('one two');
      expect(fs.readFileSync(path.join(dir, 'a'), 'utf8')).toBe('a\n');
    });

    it('keeps a quoted Windows path whole: sh eats the backslashes of a bare one', () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-posix-shell-'));
      const src = path.join(dir, 'src dir');
      fs.mkdirSync(src);
      execSync('git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m one', { cwd: src, shell: posixShell(), windowsHide: true });
      execSync(`git clone -q ${shellQuote(src)} ${shellQuote(path.join(dir, 'clone'))}`, { cwd: dir, shell: posixShell(), windowsHide: true });
      expect(fs.existsSync(path.join(dir, 'clone', '.git'))).toBe(true);
    });
  });
});

describe('posixBash()', () => {
  it('is bash off Windows, without asking git', () => {
    const gitExecPath = () => { throw new Error('must not be called'); };
    expect(posixBash({ platform: 'linux', gitExecPath, exists: () => false })).toBe('bash');
  });

  it("is Git for Windows' bin/bash.exe on win32 - not the bash.exe PATH finds first (WSL's)", () => {
    const bash = posixBash({
      platform: 'win32',
      gitExecPath: () => 'C:/Program Files/Git/ucrt64/libexec/git-core\n',
      exists: (p) => p === path.win32.join('C:/Program Files/Git', 'bin', 'bash.exe'),
    });
    expect(bash).toBe(path.win32.join('C:/Program Files/Git', 'bin', 'bash.exe'));
  });

  it('falls back to usr/bin/bash.exe, and says what is missing when there is neither', () => {
    const gitExecPath = () => 'D:\\tools\\Git\\mingw64\\libexec\\git-core';
    expect(posixBash({ platform: 'win32', gitExecPath, exists: (p) => p === path.win32.join('D:\\tools\\Git', 'usr', 'bin', 'bash.exe') }))
      .toBe(path.win32.join('D:\\tools\\Git', 'usr', 'bin', 'bash.exe'));
    expect(() => posixBash({ platform: 'win32', gitExecPath, exists: () => false })).toThrow(/No bash\.exe found in Git for Windows/);
  });

  it.skipIf(process.platform !== 'win32')('on this machine, runs a script given by its Windows path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-posix-bash-'));
    try {
      const script = path.join(dir, 'x.sh');
      fs.writeFileSync(script, 'echo "ran $1"\n');
      expect(execFileSync(posixBash(), [script, 'ok'], { encoding: 'utf8', windowsHide: true }).trim()).toBe('ran ok');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('shellQuote()', () => {
  it('single-quotes a value, so a backslash, a space or a $ reaches the command as written', () => {
    expect(shellQuote('C:\\Users\\a b\\$x')).toBe("'C:\\Users\\a b\\$x'");
  });

  it("closes, escapes and reopens around a single quote", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    const echoed = execSync(`printf %s ${shellQuote("it's \\ $HOME")}`, { shell: posixShell(), encoding: 'utf8', windowsHide: true });
    expect(echoed).toBe("it's \\ $HOME");
  });
});
