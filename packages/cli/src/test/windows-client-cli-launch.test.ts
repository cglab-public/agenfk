/**
 * BUG ad57c267 (CGLAB-434): on Windows, agenfk could not launch the AI client
 * CLIs it registers MCP with (claude, codex, gemini) or detects (cursor,
 * opencode, pi).
 *
 * Two failures, one per kind of install:
 *  - npm installs a client as a `.cmd` shim. Node >= 18.20.2 / 20.12.2 (and
 *    every 22.x agenfk supports) refuses to spawn a .cmd or .bat without a
 *    shell (CVE-2024-27980): spawnSync answers EINVAL. The installer's
 *    getCliCommand('claude') -> 'claude.cmd', spawned without a shell, hit it.
 *  - Claude Code's native installer ships claude.exe, so forcing '.cmd' was
 *    ENOENT; the CLI's spawnSync('claude', ...) in configure-ide could not run
 *    a .cmd shim either.
 *
 * Contract under test: runTool(name, args) - in scripts/client-cli.mjs
 * for the installer/uninstaller and packages/cli/src/runTool.ts for the CLI -
 * launches a client CLI by bare name on every platform, .exe or .cmd, with
 * each argument arriving intact (spaces, '&'). The installer, uninstaller and
 * `agenfk configure-ide` reach the client through it.
 *
 * Runs on Linux in the normal suite and on the Windows CI job (windows-*).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runTool as scriptsRunTool, windowsCommandLine as scriptsWindowsCommandLine, resolveWindowsTool as scriptsResolve } from '../../../../scripts/client-cli.mjs';
import { runTool as cliRunTool, windowsCommandLine as cliWindowsCommandLine, resolveWindowsTool as cliResolve } from '../runTool';
import { runInstall, runUninstall, cleanupHome } from './helpers/runInstaller';

const { home } = vi.hoisted(() => ({ home: { dir: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => home.dir || actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) { this.capture = vi.fn(); this.shutdown = vi.fn().mockResolvedValue(undefined); this.isEnabled = false; }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');

const isWin = process.platform === 'win32';
const IMPLS = [
  { side: 'scripts/client-cli.mjs', runTool: scriptsRunTool, windowsCommandLine: scriptsWindowsCommandLine, resolveWindowsTool: scriptsResolve },
  { side: 'packages/cli/src/runTool.ts', runTool: cliRunTool, windowsCommandLine: cliWindowsCommandLine, resolveWindowsTool: cliResolve },
] as const;

/** Put PATH back as it was - deleted, not set to the string "undefined", when it was unset. */
const restorePath = (saved: string | undefined) => {
  if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved;
};

/** What cmd.exe needs to start at all when PATH holds only the fake tools. */
const winEnv = (): Record<string, string> => (isWin
  ? { ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD' }
  : {});

/**
 * A directory of fake client CLIs. Each appends one line to calls.log -
 * `<name>: <its arguments>` - and exits 0, so `--version` probes succeed.
 * On Windows they are .cmd shims, the npm-installed shape that trips the
 * CVE-2024-27980 rule.
 */
function fakeBin(names: string[]): { dir: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk fake bin & co-'));
  for (const name of names) {
    if (isWin) {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n>>"%~dp0calls.log" echo ${name}: %*\r\nexit /b 0\r\n`);
    } else {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\nprintf '%s:' '${name}' >> "\${0%/*}/calls.log"\nfor a in "$@"; do printf ' %s' "$a" >> "\${0%/*}/calls.log"; done\nprintf '\\n' >> "\${0%/*}/calls.log"\nexit 0\n`);
      fs.chmodSync(file, 0o755);
    }
  }
  const log = path.join(dir, 'calls.log');
  // A .cmd's `echo %*` keeps cmd.exe's quotes around an argument; they are
  // the transport, not the argument, so they are dropped from the record.
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').replace(/"/g, '').split(/\r?\n/).filter(Boolean) : []) };
}

describe('windowsCommandLine: the command line cmd.exe is handed', () => {
  for (const impl of IMPLS) {
    describe(impl.side, () => {
      it('leaves plain arguments bare and the name unquoted, so PATHEXT finds .exe or .cmd', () => {
        expect(impl.windowsCommandLine('claude', ['mcp', 'remove', 'agenfk'])).toBe('claude mcp remove agenfk');
      });

      it('quotes an argument holding a space, so a profile path stays one argument', () => {
        expect(impl.windowsCommandLine('claude', ['-e', 'AGENFK_DB_PATH=C:\\Users\\Jo Doe\\.agenfk\\db.sqlite']))
          .toBe('claude -e "AGENFK_DB_PATH=C:\\Users\\Jo Doe\\.agenfk\\db.sqlite"');
      });

      it('quotes the characters cmd.exe would otherwise act on', () => {
        for (const ch of ['&', '|', '<', '>', '^', '(', ')', ',', '=']) {
          expect(impl.windowsCommandLine('codex', [`a${ch}b`])).toBe(`codex "a${ch}b"`);
        }
      });

      it('doubles trailing backslashes inside quotes, so the closing quote is not read as escaped', () => {
        expect(impl.windowsCommandLine('claude', ['C:\\a b\\'])).toBe('claude "C:\\a b\\\\"');
      });

      it('quotes the program itself when its absolute path holds a space', () => {
        expect(impl.windowsCommandLine('C:\\Users\\Jo Doe\\npm\\claude.cmd', ['--version']))
          .toBe('"C:\\Users\\Jo Doe\\npm\\claude.cmd" --version');
      });

      it('passes an empty argument as ""', () => {
        expect(impl.windowsCommandLine('gemini', ['mcp', ''])).toBe('gemini mcp ""');
      });

      it('refuses an argument holding a double quote rather than let it split the line', () => {
        expect(() => impl.windowsCommandLine('claude', ['say "hi"'])).toThrow(/double quote/);
      });
    });
  }
});

describe('resolveWindowsTool: which file a Windows launch runs', () => {
  // Pure over its env argument, so it is pinned on every platform.
  let a: string; let b: string;
  beforeAll(() => {
    a = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk resolve a-'));
    b = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk resolve b-'));
    fs.writeFileSync(path.join(a, 'tool.cmd'), '');
    fs.writeFileSync(path.join(b, 'tool.exe'), '');
    fs.writeFileSync(path.join(b, 'tool.js'), '');
  });
  afterAll(() => { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }); });

  for (const impl of IMPLS) {
    describe(impl.side, () => {
      it('takes the first PATH directory holding a launchable file, by PATHEXT order', () => {
        expect(impl.resolveWindowsTool('tool', { PATH: `${a};${b}`, PATHEXT: '.EXE;.CMD' })).toBe(path.join(a, 'tool.cmd'));
        expect(impl.resolveWindowsTool('tool', { PATH: `${b};${a}`, PATHEXT: '.EXE;.CMD' })).toBe(path.join(b, 'tool.exe'));
      });

      it('never picks a .js or other script extension, whatever PATHEXT says', () => {
        fs.rmSync(path.join(b, 'tool.exe'));
        try {
          expect(impl.resolveWindowsTool('tool', { PATH: b, PATHEXT: '.JS;.EXE;.CMD' })).toBeNull();
        } finally {
          fs.writeFileSync(path.join(b, 'tool.exe'), '');
        }
      });

      it('skips a relative PATH entry, which would be the current-directory lookup again', () => {
        // Relative to a cwd it really resolves from: path.relative(repo, tmp)
        // is absolute on Windows when the two sit on different drives.
        const cwd = process.cwd();
        process.chdir(path.dirname(a));
        try {
          const rel = path.basename(a);
          expect(fs.existsSync(path.join(rel, 'tool.cmd'))).toBe(true);
          expect(impl.resolveWindowsTool('tool', { PATH: rel, PATHEXT: '.CMD' })).toBeNull();
        } finally {
          process.chdir(cwd);
        }
      });

      it('passes over a directory that merely carries a launchable name', () => {
        const c = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk resolve c-'));
        try {
          fs.mkdirSync(path.join(c, 'tool.exe'));
          fs.writeFileSync(path.join(c, 'tool.cmd'), '');
          expect(impl.resolveWindowsTool('tool', { PATH: c, PATHEXT: '.EXE;.CMD' })).toBe(path.join(c, 'tool.cmd'));
        } finally {
          fs.rmSync(c, { recursive: true, force: true });
        }
      });

      it('falls back to .exe/.cmd/.bat when PATHEXT is set but empty', () => {
        expect(impl.resolveWindowsTool('tool', { PATH: a, PATHEXT: '' })).toBe(path.join(a, 'tool.cmd'));
      });

      it('reads Path as well as PATH (Windows env keys are case-insensitive)', () => {
        expect(impl.resolveWindowsTool('tool', { Path: a, PATHEXT: '.CMD' })).toBe(path.join(a, 'tool.cmd'));
      });
    });
  }
});

describe('runTool launches a client CLI by bare name on this platform', () => {
  let bin: ReturnType<typeof fakeBin>;
  let savedPath: string | undefined;
  beforeAll(() => {
    bin = fakeBin(['fakeclient']);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin.dir}${path.delimiter}${savedPath ?? ''}`;
  });
  afterAll(() => {
    restorePath(savedPath);
    fs.rmSync(bin.dir, { recursive: true, force: true });
  });

  for (const impl of IMPLS) {
    it(`${impl.side}: runs it and hands it every argument, a path with a space and '&' included`, () => {
      const before = bin.calls().length;
      const dbArg = `AGENFK_DB_PATH=${path.join(bin.dir, 'db.sqlite')}`;

      const res = impl.runTool('fakeclient', ['mcp', 'add', '-e', dbArg, '--', 'agenfk'], { encoding: 'utf8' });

      expect(res.error, String(res.error)).toBeUndefined();
      expect(res.status).toBe(0);
      const line = bin.calls()[before];
      expect(line).toMatch(/^fakeclient: mcp add -e /);
      expect(line).toContain(dbArg);
      expect(line).toMatch(/ -- agenfk$/);
    });
  }

  for (const impl of IMPLS) {
    it(`${impl.side}: a client that is not installed answers ENOENT, not a crash or a cmd.exe status`, () => {
      const res = impl.runTool('agenfk-no-such-client', ['--version'], { stdio: 'ignore' });

      expect(res.status).toBeNull();
      expect((res.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
    });
  }

  it.runIf(isWin)('never runs a same-named file from the current directory instead of the client on PATH', () => {
    // cmd.exe would look in the cwd first and try every PATHEXT extension:
    // a repo's stray fakeclient.js / fakeclient.cmd would run in its place.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk decoy cwd-'));
    try {
      fs.writeFileSync(path.join(cwd, 'fakeclient.cmd'), '@echo off\r\n>>"%~dp0decoy.log" echo ran\r\nexit /b 0\r\n');
      fs.writeFileSync(path.join(cwd, 'fakeclient.js'), 'WScript.Quit(0);');
      for (const impl of IMPLS) {
        const before = bin.calls().length;

        const res = impl.runTool('fakeclient', ['--version'], { cwd, encoding: 'utf8' });

        expect(res.status, impl.side).toBe(0);
        expect(bin.calls().length, impl.side).toBe(before + 1);
        expect(fs.existsSync(path.join(cwd, 'decoy.log')), impl.side).toBe(false);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.runIf(isWin)('(premise) a .cmd spawned without a shell is refused by this Node', () => {
    const res = spawnSync(path.join(bin.dir, 'fakeclient.cmd'), ['--version']);
    expect(res.status).toBeNull();
    expect((res.error as NodeJS.ErrnoException | undefined)?.code).toBe('EINVAL');
  });

  it.runIf(isWin)('runs a native .exe client too, each argument intact', () => {
    // Claude Code's native Windows installer ships claude.exe, not a shim.
    const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk exe & co-'));
    try {
      fs.copyFileSync(process.execPath, path.join(exeDir, 'fakeexe.exe'));
      const script = path.join(exeDir, 'argv.js');
      fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      const saved = process.env.PATH;
      process.env.PATH = `${exeDir}${path.delimiter}${saved ?? ''}`;
      try {
        for (const impl of IMPLS) {
          const res = impl.runTool('fakeexe', [script, 'a b', 'c&d', 'plain'], { encoding: 'utf8' });
          expect(res.status, `${impl.side}: ${res.stderr}`).toBe(0);
          expect(JSON.parse(String(res.stdout))).toEqual(['a b', 'c&d', 'plain']);
        }
      } finally {
        restorePath(saved);
      }
    } finally {
      fs.rmSync(exeDir, { recursive: true, force: true });
    }
  });
});

describe('the installer and uninstaller reach the client CLIs', () => {
  let bin: ReturnType<typeof fakeBin>;
  const homes: string[] = [];
  // A profile path with a space and '&', the shape that has to survive cmd.exe.
  const newHome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk home & co-')); homes.push(h); return h; };
  beforeEach(() => { bin = fakeBin(['claude', 'codex', 'gemini']); });
  afterEach(() => fs.rmSync(bin.dir, { recursive: true, force: true }));
  afterAll(() => { for (const h of homes) cleanupHome(h); });

  for (const client of ['claude', 'gemini'] as const) {
    it(`install --with-mcp registers the agenfk MCP server with ${client}`, () => {
      const h = newHome();

      const r = runInstall(['--with-mcp', `--only=${client}`, '--rules-scope=global'], h, undefined, { PATH: bin.dir, ...winEnv() });

      expect(r.status, r.stdout + r.stderr).toBe(0);
      const add = bin.calls().find((c) => c.startsWith(`${client}: mcp add`));
      expect(add, bin.calls().join('\n')).toBeDefined();
      // The db path the install recorded (a dev checkout keeps its own DB),
      // arriving as one argument.
      const { dbPath } = JSON.parse(fs.readFileSync(path.join(h, '.agenfk', 'config.json'), 'utf8'));
      expect(add).toContain(`AGENFK_DB_PATH=${dbPath}`);
      // claude is also handed the installed bin, under a HOME with a space and '&'.
      if (client === 'claude') expect(add).toContain(`agenfk ${path.join(h, '.local', 'bin', isWin ? 'agenfk.cmd' : 'agenfk')} mcp`);
    }, 120_000);
  }

  it('install registers the agenfk MCP server with codex (on by default)', () => {
    const h = newHome();

    const r = runInstall(['--only=codex', '--rules-scope=global'], h, undefined, { PATH: bin.dir, ...winEnv() });

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(bin.calls().some((c) => c.startsWith('codex: mcp add')), bin.calls().join('\n')).toBe(true);
  }, 120_000);

  it('uninstall removes the agenfk MCP server from claude', () => {
    const h = newHome();

    const r = runUninstall(['-y', '--only=claude'], h, undefined, { PATH: bin.dir, ...winEnv() });

    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(bin.calls()).toContain('claude: mcp remove agenfk');
  }, 120_000);
});

describe('agenfk configure-ide reaches claude', () => {
  let bin: ReturnType<typeof fakeBin>;
  let project: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    bin = fakeBin(['claude']);
    home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk ide home & co-'));
    fs.mkdirSync(path.join(home.dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(path.join(home.dir, '.agenfk', 'config.json'), JSON.stringify({ dbPath: path.join(home.dir, '.agenfk', 'db.sqlite') }));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk ide project-'));
    fs.mkdirSync(path.join(project, '.agenfk'));
    fs.writeFileSync(path.join(project, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p-1' }));
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin.dir}${path.delimiter}${savedPath ?? ''}`;
  });
  afterEach(() => {
    restorePath(savedPath);
    vi.restoreAllMocks();
    for (const d of [bin.dir, home.dir, project]) fs.rmSync(d, { recursive: true, force: true });
    home.dir = '';
  });

  it('registers the server with the db path intact, a space and "&" in it', async () => {
    const { program } = await import('../index');

    await program.parseAsync(['node', 'agenfk', 'configure-ide']);

    const add = bin.calls().find((c) => c.startsWith('claude: mcp add'));
    expect(add, bin.calls().join('\n')).toBeDefined();
    expect(add).toContain(`AGENFK_DB_PATH=${path.join(home.dir, '.agenfk', 'db.sqlite')}`);
  });
});
