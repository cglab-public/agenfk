import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Command } from 'commander';

/*
 * commander 13+ rejects excess positional arguments by default (PR #316 moved
 * the CLI to commander 15). The CLI adopts that strict mode for every
 * subcommand, with one deliberate exception: the ROOT program. Its action is
 * where `reportUnknownCommand` turns leftover tokens into
 * "unknown command 'x'" plus a suggestion; under strict mode commander refused
 * those tokens first and printed "too many arguments. Expected 0 arguments".
 *
 * These run in the root vitest run (cli.test.ts, which also covers the unknown
 * command, is excluded from it and never ran in CI).
 */

vi.mock('@agenfk/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agenfk/telemetry')>()),
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = false;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://127.0.0.1:9'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));

import { program } from '../index';

/** Run the CLI with process.exit trapped; returns the exit code and all stderr. */
async function run(argv: string[]): Promise<{ code: number | undefined; stderr: string }> {
  const errLines: string[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errLines.push(a.join(' ')); });
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { errLines.push(String(chunk)); return true; }) as never);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);
  let code: number | undefined;
  try {
    await program.parseAsync(['node', 'agenfk', ...argv]);
  } catch (e: any) {
    const m = String(e?.message ?? '').match(/^__exit__:(\d+)$/);
    if (!m) throw e;
    code = parseInt(m[1], 10);
  } finally {
    errSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return { code, stderr: errLines.join('\n').replace(/\x1b\[[0-9;]*m/g, '') };
}

function allowsExcess(cmd: Command): boolean {
  return (cmd as unknown as { _allowExcessArguments: boolean })._allowExcessArguments;
}

function walk(cmd: Command, prefix: string[] = []): Array<{ path: string; cmd: Command }> {
  return cmd.commands.flatMap((sub) => {
    const p = [...prefix, sub.name()];
    return [{ path: p.join(' '), cmd: sub }, ...walk(sub, p)];
  });
}

describe('commander strict mode: unknown commands at the root', () => {
  beforeEach(() => {
    for (const k of Object.keys(program.opts())) program.setOptionValue(k, undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports an unknown top-level command as unknown, not as too many arguments', async () => {
    const { code, stderr } = await run(['bogus-command']);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown command 'bogus-command'");
    expect(stderr).not.toContain('too many arguments');
  });

  it('suggests the command a typo was close to', async () => {
    const { code, stderr } = await run(['flows', 'show']);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown command 'flows'");
    expect(stderr).toContain("did you mean 'flow'?");
  });
});

describe('commander strict mode: subcommands refuse excess arguments', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses an extra positional argument to a command that takes none', async () => {
    const { code, stderr } = await run(['current-project', 'extra-arg']);
    expect(code).toBe(1);
    expect(stderr).toContain("too many arguments for 'current-project'");
  });

  it('refuses an extra positional argument to a command that takes one', async () => {
    const { code, stderr } = await run(['get', 'some-id', 'stray']);
    expect(code).toBe(1);
    expect(stderr).toContain("too many arguments for 'get'");
  });

  it('refuses an extra positional argument to a command nested in command groups', async () => {
    // `config set telemetry <value>`: a leaf two groups deep.
    const { code, stderr } = await run(['config', 'set', 'telemetry', 'true', 'stray']);
    expect(code).toBe(1);
    expect(stderr).toContain("too many arguments for 'telemetry'");
  });

  it('refuses an extra positional argument to a command that has both subcommands and an action', async () => {
    // `config set [key] [value]` has its own action and subcommands: commander checks its own arguments there.
    const { code, stderr } = await run(['config', 'set', 'a', 'b', 'c']);
    expect(code).toBe(1);
    expect(stderr).toContain("too many arguments for 'set'");
  });

  it('keeps the root exception from leaking: only the airlock pass-through commands accept excess arguments', () => {
    expect(allowsExcess(program)).toBe(true);
    const loose = walk(program).filter((c) => allowsExcess(c.cmd)).map((c) => c.path);
    expect(loose.length).toBeGreaterThan(0);
    // `airlock exec -- '<cmd>'` and `airlock <client> <args...>` forward their arguments verbatim.
    for (const p of loose) expect(p).toMatch(/^airlock \S+$/);
    expect(loose).toContain('airlock exec');
  });
});
