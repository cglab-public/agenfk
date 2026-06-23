/**
 * Tests for the global --toon flag wiring on read commands.
 * With --toon, structured output is TOON; without it, JSON/table as before.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = true;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync, writeFileSync: vi.fn(), mkdirSync: vi.fn() },
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('figlet', () => ({ default: { textSync: vi.fn().mockReturnValue('AgEnFK') } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

function resetCommanderOptions(cmd: any) {
  ((cmd as any).options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  resetCommanderOptions(program);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('global --toon flag', () => {
  it('is registered as a program-level option', () => {
    const names = program.options.map((o: any) => o.long);
    expect(names).toContain('--toon');
  });

  it('list --toon emits a TOON table instead of JSON', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [
        { id: 'aaaaaaaa-1', type: 'TASK', title: 'One', status: 'TODO', parentId: null },
        { id: 'bbbbbbbb-2', type: 'BUG', title: 'Two', status: 'TODO', parentId: null },
      ],
    });

    await program.parseAsync(['node', 'agenfk', '--toon', 'list', '--all']);

    const out = printed();
    expect(out).toMatch(/\[2\]\{/);   // tabular header with count
    expect(out).not.toMatch(/^\s*\[\s*\n\s*\{/m); // not pretty JSON array
  });

  it('list --json (no --toon) still emits JSON', async () => {
    mockedAxios.get.mockResolvedValue({ data: [{ id: 'x', type: 'TASK', title: 't', status: 'TODO', parentId: null }] });

    await program.parseAsync(['node', 'agenfk', 'list', '--all', '--json']);

    expect(printed()).toMatch(/"id":/);
  });
});
