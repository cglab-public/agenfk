/**
 * `agenfk ui --open <itemId>` — deep-link the dashboard to a specific item.
 *
 * User-facing contract exercised here (CGLAB-100):
 *  - `resolveDashboardUrl` keeps the existing base-URL behaviour: the URL
 *    is the server's port (it serves the board; 24a7b899), else the API default.
 *  - `buildUiOpenUrl` appends `?item=<itemId>` (and `&project=<projectId>`
 *    when the current project resolves) to that base, URL-encoding values.
 *  - the commander `ui` command accepts `--open <itemId>`.
 *  - running `ui --open <id>` launches the browser with a URL carrying both
 *    query params when `.agenfk/project.json` resolves, and with only
 *    `?item=` when it does not. The actual browser-open is environmental
 *    (same as the restart-quiet tests treat the start-services script): we
 *    intercept the execSync call and assert on the URL it received.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { program } from '../index';
import { buildUiOpenUrl, resolveDashboardUrl } from '../uiUrl';

// Capture every launch instead of making one: the browser through execSync, the desktop app through
// execFileSync (`open -a`). With only execSync mocked, a machine holding a desktop build (the source
// tree's packages/desktop/release) had the test open the real app on every run.
// The app is never running here: `pgrep` finds nothing, as on a machine without it.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn((cmd: unknown) => {
      if (String(cmd).startsWith('pgrep')) throw new Error('no process found');
      return Buffer.from('');
    }),
    execFileSync: vi.fn(() => Buffer.from('')),
  };
});

// Keep the item->project lookup hermetic: default to "server unreachable" so
// the action falls back to the cwd project deterministically, on any machine.
vi.mock('axios', () => ({
  default: { get: vi.fn(() => Promise.reject(new Error('server unreachable'))) },
}));

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function uiCommand() {
  const cmd = program.commands.find((c) => c.name() === 'ui');
  expect(cmd, 'command "ui" should be registered').toBeDefined();
  return cmd as any;
}

describe('resolveDashboardUrl', () => {
  // 24a7b899: the server serves the board (one origin); no separate UI process records a URL any more.
  it('ignores a vite URL an older install left in .agenfk/ui.log: the board is the server\'s', () => {
    const dir = makeTmpDir('agenfk-ui-open-');
    try {
      fs.mkdirSync(path.join(dir, '.agenfk'));
      fs.writeFileSync(path.join(dir, '.agenfk', 'ui.log'), '  ➜  Local:   http://localhost:5174/\n');
      expect(resolveDashboardUrl(dir)).toBe('http://localhost:3000');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('with no server port recorded, is the API\'s default port', () => {
    const dir = makeTmpDir('agenfk-ui-open-');
    try {
      expect(resolveDashboardUrl(dir)).toBe('http://localhost:3000');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

});

describe('buildUiOpenUrl', () => {
  const base = 'http://localhost:5173';

  it('appends ?item=<itemId> to the base dashboard URL', () => {
    expect(buildUiOpenUrl(base, 'abc-123')).toBe('http://localhost:5173?item=abc-123');
  });

  it('appends &project=<projectId> when a project is given', () => {
    expect(buildUiOpenUrl(base, 'abc-123', 'proj-1')).toBe(
      'http://localhost:5173?item=abc-123&project=proj-1'
    );
  });

  it('omits the project param when no project resolves', () => {
    expect(buildUiOpenUrl(base, 'abc-123', null)).toBe('http://localhost:5173?item=abc-123');
    expect(buildUiOpenUrl(base, 'abc-123', undefined)).toBe('http://localhost:5173?item=abc-123');
  });

  it('URL-encodes the item id so the UI decodes back to the exact id', () => {
    const url = buildUiOpenUrl(base, 'a b&c');
    // The KanbanBoard reads the param back with URLSearchParams — the contract
    // is a lossless round-trip, not a specific escape style.
    const decoded = new URLSearchParams(url.split('?')[1]).get('item');
    expect(decoded).toBe('a b&c');
  });

  it('asks the board to open the card on Overview when view is given (c8e35fb8)', () => {
    const url = buildUiOpenUrl(base, 'abc-123', 'proj-1', { view: 'overview' });
    expect(new URLSearchParams(url.split('?')[1]).get('view')).toBe('overview');
  });

  it('carries no view by default: a plain --open only highlights', () => {
    expect(buildUiOpenUrl(base, 'abc-123', 'proj-1')).not.toContain('view=');
  });

  it('joins with & when the base URL already carries a query string', () => {
    expect(buildUiOpenUrl('http://localhost:5173?theme=dark', 'abc-123', 'proj-1')).toBe(
      'http://localhost:5173?theme=dark&item=abc-123&project=proj-1'
    );
  });
});

describe('agenfk ui --open command', () => {
  it('declares the --open <itemId> option', () => {
    const longs = uiCommand().options.map((o: any) => o.long);
    expect(longs).toContain('--open');
  });

  it('declares --details, which opens the card instead of only highlighting it', () => {
    const longs = uiCommand().options.map((o: any) => o.long);
    expect(longs).toContain('--details');
  });
});

/*
 * `--web` on every invocation here, and it is not a workaround.
 *
 * These tests are about the URL the command BUILDS - the ?item and ?project
 * deep link - not about which surface receives it. `agenfk ui` now prefers the
 * desktop app when one is installed, so without the flag they would be testing
 * the surface choice and asserting the URL by accident, and they would pass or
 * fail depending on whether the machine running CI happens to have the app.
 *
 * The surface choice has its own tests in openTarget.test.ts.
 */
describe('agenfk ui --open browser launch', () => {
  let tmpCwd: string;
  let realCwd: string;

  beforeEach(() => {
    // The shared commander program keeps parsed option values between parse
    // calls (a real CLI invocation is a fresh process); drop a stale --open so
    // each test starts clean.
    uiCommand().setOptionValue('open', undefined);
  });

  afterEach(() => {
    if (realCwd) process.chdir(realCwd);
    realCwd = '';
    if (tmpCwd) fs.rmSync(tmpCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmpCwd = '';
    vi.mocked(execSync).mockClear();
    vi.mocked(execFileSync).mockClear();
    vi.restoreAllMocks();
  });

  /** Whether a desktop app is installed, whatever this machine holds. */
  const desktopInstalled = (installed: boolean) => {
    const exists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (String(p).endsWith('AgEnFK.app') ? installed : exists(p)));
  };

  // The launch command is a platform opener wrapping the URL in quotes
  // (e.g. `open "<url>"` or `xdg-open "<url>"`) — extract that URL.
  const launchedUrls = (): string[] =>
    vi.mocked(execSync).mock.calls
      .map((c) => String(c[0]).match(/"(http[^"]+)"/) ?? null)
      .filter((m): m is string[] => m !== null)
      .map((m) => m[1]);

  it('launches the browser with ?item and ?project when the current project resolves', async () => {
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    fs.mkdirSync(path.join(tmpCwd, '.agenfk'));
    fs.writeFileSync(path.join(tmpCwd, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'proj-1' }));
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', 'item-123']);

    const urls = launchedUrls().filter((u) => u.includes('?item=item-123'));
    expect(urls.length).toBeGreaterThan(0);
    // The base port is whatever the dev server recorded in ui.log; the
    // contract under test is the query string, not the port.
    expect(urls.every((u) => u.startsWith('http://localhost:'))).toBe(true);
    expect(urls[0]).toContain('?item=item-123&project=proj-1');
  });

  it('--details adds view=overview to the launched URL', async () => {
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);
    try {
      await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', 'item-789', '--details']);
    } finally {
      // Commander keeps option values on the shared program between parses.
      uiCommand().setOptionValue('details', undefined);
    }
    const urls = launchedUrls().filter((u) => u.includes('?item=item-789'));
    expect(urls.length).toBeGreaterThan(0);
    expect(new URLSearchParams(urls[0].split('?')[1]).get('view')).toBe('overview');
  });

  it('launches with only ?item when no project resolves (server unreachable, no cwd project)', async () => {
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    // No .agenfk directory anywhere up this tmp dir's tree.
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', 'item-456']);

    const urls = launchedUrls().filter((u) => u.includes('?item=item-456'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('project='))).toBe(true);
  });

  it('opens the project the ITEM belongs to (from the server), not the cwd project', async () => {
    // The item's real project must win over the cwd — a cross-project
    // 'show item X' must not silently switch the board to the wrong project.
    vi.mocked(axios.get).mockImplementationOnce(async () => ({ data: { projectId: 'proj-item-home' } }) as any);
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    fs.mkdirSync(path.join(tmpCwd, '.agenfk'));
    fs.writeFileSync(path.join(tmpCwd, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'proj-cwd' }));
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', 'item-777']);

    const urls = launchedUrls().filter((u) => u.includes('?item=item-777'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('?item=item-777&project=proj-item-home');
    expect(urls[0]).not.toContain('proj-cwd');
  });

  it('rejects an empty --open value instead of silently opening the plain dashboard', async () => {
    const savedExitCode = process.exitCode;
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', '']);

    expect(process.exitCode).toBe(1);
    expect(launchedUrls().length).toBe(0);
    process.exitCode = savedExitCode;
  });

  it('never leaks shell metacharacters from a hostile item id into the launch command', async () => {
    // The id flows argv -> URLSearchParams -> `open "<url>"`. URLSearchParams
    // must encode everything that could break the quoting ($, backtick, ").
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', 'a"; echo $(id) `id`']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    expect(calls.length).toBeGreaterThan(0);
    for (const cmd of calls) {
      // exactly the two wrapping quotes around the URL — nothing else. Windows' `start "" "<url>"`
      // also carries the empty window title, which is not the id's: set it aside first.
      expect((cmd.replace(/\bstart "" /, 'start ').match(/"/g) ?? []).length).toBe(2);
      expect(cmd).not.toMatch(/\$\(|`|; /);
    }
    // and the id still round-trips losslessly through the query string
    const url = launchedUrls()[0];
    expect(new URLSearchParams(url.split('?')[1]).get('item')).toBe('a"; echo $(id) `id`');
  });

  it('still opens the plain dashboard when --open is absent', async () => {
    desktopInstalled(false);
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui']);

    const urls = launchedUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('?item='))).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('with a desktop app installed, opens it (through the mocked opener, never for real)', async () => {
    desktopInstalled(true);
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui']);

    const opened = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'open');
    expect(opened).toHaveLength(1);
    expect(String((opened[0][1] as string[])[1])).toMatch(/AgEnFK\.app$/);
    expect(launchedUrls()).toEqual([]);
  });

  // #208: native Windows (PowerShell, cmd, the desktop app - no MSYSTEM) had no launch
  // branch at all, and `start "<url>"` takes the quoted URL as the window TITLE and opens nothing.
  it.skipIf(process.platform !== 'win32')('on native Windows, launches with start and an empty window title', async () => {
    const saved = { MSYSTEM: process.env.MSYSTEM, MINGW_PREFIX: process.env.MINGW_PREFIX };
    delete process.env.MSYSTEM;
    delete process.env.MINGW_PREFIX;
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);
    try {
      await program.parseAsync(['node', 'agenfk', 'ui', '--web', '--open', 'item-win']);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const launches = vi.mocked(execSync).mock.calls.map((c) => String(c[0])).filter((c) => c.includes('?item=item-win'));
    expect(launches.length).toBeGreaterThan(0);
    for (const cmd of launches) expect(cmd).toMatch(/^start "" "http:\/\/localhost:\d+\/?\?item=item-win/);
  });
});