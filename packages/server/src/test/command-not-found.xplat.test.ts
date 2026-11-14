/**
 * @file GitHub #208 phase 5 — telling "could not be run" from "ran and failed" on Windows.
 *
 * sh answers a missing command with exit 127. cmd.exe answers it with exit 1 -
 * the same code a red suite gives - and a localised message on stderr. So on
 * Windows a broken PATH or a misspelt runner read as a failing suite. The
 * command still runs as written; only when it FAILS is its first word looked
 * up the way cmd.exe would, and the report says when it resolves to nothing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandEntryExists, missingCommandOnWindows } from '../commandNotFound';

const deps = (found: string[]) => ({
  pathEnv: 'C:\\tools;C:\\Windows\\System32',
  pathExt: '.COM;.EXE;.BAT;.CMD',
  cwd: 'C:\\repo',
  exists: (p: string) => found.includes(p.toLowerCase()),
});

describe('missingCommandOnWindows()', () => {
  it('names a first word found nowhere: not a builtin, not a file, not on PATH', () => {
    expect(missingCommandOnWindows('this-binary-does-not-exist-agenfk --run', deps([]))).toBe('this-binary-does-not-exist-agenfk');
  });

  it('finds a command on PATH under any PATHEXT extension', () => {
    expect(missingCommandOnWindows('npm test', deps(['c:\\tools\\npm.cmd']))).toBeNull();
    expect(missingCommandOnWindows('node -e 1', deps(['c:\\tools\\node.exe']))).toBeNull();
  });

  it("knows cmd.exe's own commands, which are on no PATH", () => {
    for (const c of ['exit 1', 'echo hi', 'cd sub && npm test', 'IF EXIST x echo y', 'set A=1']) {
      expect(missingCommandOnWindows(c, deps([])), c).toBeNull();
    }
  });

  it('takes a quoted path, a relative path and a path with its extension as they are', () => {
    expect(missingCommandOnWindows('"C:\\Program Files\\nodejs\\node.exe" -v', deps(['c:\\program files\\nodejs\\node.exe']))).toBeNull();
    expect(missingCommandOnWindows('.\\run.cmd', deps(['c:\\repo\\run.cmd']))).toBeNull();
    expect(missingCommandOnWindows('C:\\gone\\tool.exe', deps([]))).toBe('C:\\gone\\tool.exe');
  });

  it('says nothing for a command it cannot read a first word from', () => {
    expect(missingCommandOnWindows('', deps([]))).toBeNull();
    expect(missingCommandOnWindows('"unterminated', deps([]))).toBeNull();
  });

  // Review of #208 phase 5: words cmd.exe rewrites before it looks them up.
  it('makes no claim about a first word cmd.exe expands first (%VAR%, !VAR!)', () => {
    for (const c of ['%PYTHON% -m pytest', '%COMSPEC% /c exit 1', '!RUNNER! test']) {
      expect(missingCommandOnWindows(c, deps([])), c).toBeNull();
    }
  });

  it('reads past the @ that only silences echo', () => {
    expect(missingCommandOnWindows('@npx vitest run', deps(['c:\\tools\\npx.cmd']))).toBeNull();
    expect(missingCommandOnWindows('@nope-agenfk run', deps([]))).toBe('nope-agenfk');
  });

  it('knows the builtins written glued to their argument, and rem', () => {
    for (const c of ['echo.hi', 'echo:hi', 'cd..', 'cd\\sub', 'rem a note', 'REM']) {
      expect(missingCommandOnWindows(c, deps([])), c).toBeNull();
    }
  });
});

describe('commandEntryExists()', () => {
  it('is false for a path that is not there', () => {
    expect(commandEntryExists(path.join(os.tmpdir(), `agenfk-no-such-${process.pid}.exe`))).toBe(false);
  });

  it('is true for a file that is there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-cmd-entry-'));
    try {
      const f = path.join(dir, 'tool.cmd');
      fs.writeFileSync(f, '@echo off');
      expect(commandEntryExists(f)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // An App Execution Alias (Store Python, winget) is a reparse point stat()
  // cannot open (EACCES), so existsSync calls it absent - yet cmd.exe runs it,
  // and a red `python -m pytest` read as "python was not found".
  const aliases = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '';
  const alias = aliases && fs.existsSync(aliases)
    ? fs.readdirSync(aliases).filter(f => f.toLowerCase().endsWith('.exe')).map(f => path.join(aliases, f))
      .find(f => !fs.existsSync(f)) : undefined;
  it.skipIf(!alias)('counts an App Execution Alias as there, which existsSync does not', () => {
    expect(commandEntryExists(alias!)).toBe(true);
  });
});
