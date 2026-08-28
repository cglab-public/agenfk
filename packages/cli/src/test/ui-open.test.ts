/**
 * `agenfk ui --open <itemId>` — deep-link the dashboard to a specific item.
 *
 * User-facing contract exercised here (CGLAB-100):
 *  - `resolveDashboardUrl` keeps the existing base-URL behaviour: the URL
 *    recorded in `<root>/.agenfk/ui.log` wins, else the default dev port.
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
import { execSync } from 'child_process';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { program } from '../index';
import { buildUiOpenUrl, resolveDashboardUrl } from '../uiUrl';

// Capture the browser-launch instead of opening one in the test environment.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn(() => Buffer.from('')) };
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
  it('falls back to the default dev-server URL when no ui.log exists', () => {
    const dir = makeTmpDir('agenfk-ui-open-');
    try {
      expect(resolveDashboardUrl(dir)).toBe('http://localhost:5173');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the URL recorded in .agenfk/ui.log', () => {
    const dir = makeTmpDir('agenfk-ui-open-');
    try {
      fs.mkdirSync(path.join(dir, '.agenfk'));
      fs.writeFileSync(
        path.join(dir, '.agenfk', 'ui.log'),
        'VITE ready in 120 ms\n  ➜  Local:   http://localhost:5174/\n'
      );
      expect(resolveDashboardUrl(dir)).toBe('http://localhost:5174');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the default when ui.log has no parseable URL', () => {
    const dir = makeTmpDir('agenfk-ui-open-');
    try {
      fs.mkdirSync(path.join(dir, '.agenfk'));
      fs.writeFileSync(path.join(dir, '.agenfk', 'ui.log'), 'no urls in here');
      expect(resolveDashboardUrl(dir)).toBe('http://localhost:5173');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
});

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
    if (tmpCwd) fs.rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = '';
    vi.mocked(execSync).mockClear();
  });

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

    await program.parseAsync(['node', 'agenfk', 'ui', '--open', 'item-123']);

    const urls = launchedUrls().filter((u) => u.includes('?item=item-123'));
    expect(urls.length).toBeGreaterThan(0);
    // The base port is whatever the dev server recorded in ui.log; the
    // contract under test is the query string, not the port.
    expect(urls.every((u) => u.startsWith('http://localhost:'))).toBe(true);
    expect(urls[0]).toContain('?item=item-123&project=proj-1');
  });

  it('launches with only ?item when no project resolves (server unreachable, no cwd project)', async () => {
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    // No .agenfk directory anywhere up this tmp dir's tree.
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui', '--open', 'item-456']);

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

    await program.parseAsync(['node', 'agenfk', 'ui', '--open', 'item-777']);

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

    await program.parseAsync(['node', 'agenfk', 'ui', '--open', '']);

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

    await program.parseAsync(['node', 'agenfk', 'ui', '--open', 'a"; echo $(id) `id`']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    expect(calls.length).toBeGreaterThan(0);
    for (const cmd of calls) {
      // exactly the two wrapping quotes around the URL — nothing else
      expect((cmd.match(/"/g) ?? []).length).toBe(2);
      expect(cmd).not.toMatch(/\$\(|`|; /);
    }
    // and the id still round-trips losslessly through the query string
    const url = launchedUrls()[0];
    expect(new URLSearchParams(url.split('?')[1]).get('item')).toBe('a"; echo $(id) `id`');
  });

  it('still opens the plain dashboard when --open is absent', async () => {
    realCwd = process.cwd();
    tmpCwd = makeTmpDir('agenfk-ui-open-cwd-');
    process.chdir(tmpCwd);

    await program.parseAsync(['node', 'agenfk', 'ui']);

    const urls = launchedUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('?item='))).toBe(true);
  });
});