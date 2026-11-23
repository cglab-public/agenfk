import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { TOKEN_CLIENTS } from '@agenfk/core';

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

async function runCli(argv: string[]): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { outLines.push(a.join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errLines.push(a.join(' ')); });
  const writeErrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { errLines.push(String(chunk)); return true; }) as never);
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
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeErrSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return {
    code,
    stdout: outLines.join('\n'),
    // eslint-disable-next-line no-control-regex
    stderr: errLines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''),
  };
}

describe('agenfk tokens --client enum (GH-413)', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
    const tokensCmd = program.commands.find((c) => c.name() === 'tokens');
    if (tokensCmd) {
      for (const k of Object.keys(tokensCmd.opts())) tokensCmd.setOptionValue(k, undefined);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('exports canonical TOKEN_CLIENTS from @agenfk/core including agy and pi', () => {
    expect(TOKEN_CLIENTS).toBeDefined();
    expect(TOKEN_CLIENTS).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini', 'cursor', 'opencode', 'pi', 'agy']));
  });

  it('registers TOKEN_CLIENTS choices on the tokens --client option', () => {
    const tokensCmd = program.commands.find((c) => c.name() === 'tokens');
    expect(tokensCmd).toBeDefined();
    const clientOpt = tokensCmd!.options.find((o) => o.long === '--client');
    expect(clientOpt).toBeDefined();
    expect(clientOpt!.argChoices).toEqual([...TOKEN_CLIENTS]);
  });

  it('accepts --client agy and forwards client=agy to GET /token-events', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: [] } as any);
    const res = await runCli(['tokens', '--client', 'agy']);
    expect(res.code).toBeUndefined();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/token-events$/),
      { params: expect.objectContaining({ client: 'agy' }) },
    );
  });

  it('accepts --client pi and forwards client=pi to GET /token-events', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: [] } as any);
    const res = await runCli(['tokens', '--client', 'pi']);
    expect(res.code).toBeUndefined();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/token-events$/),
      { params: expect.objectContaining({ client: 'pi' }) },
    );
  });

  it('rejects an unknown --client value before calling the server and lists agy in allowed choices', async () => {
    const res = await runCli(['tokens', '--client', 'not-a-client']);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Allowed choices/i);
    expect(res.stderr).toMatch(/agy/);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
