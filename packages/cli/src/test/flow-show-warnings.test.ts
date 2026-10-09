/**
 * @file CGLAB-457 (T3) — `agenfk flow show` says when a step's words ask for a
 * review or a person's go-ahead its checks do not enforce, and who can fix it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factories
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = mockCapture;
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
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));

// Mock inquirer
const mockInquirerPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: { prompt: mockInquirerPrompt },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);

const step = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: name, name, label: name, order, ...extra });
const UNCHECKED = {
  id: 'flow-1', name: 'TDD Flow', description: '', version: '1.0.0', source: 'hub',
  steps: [
    step('TODO', 0, { isAnchor: true }),
    step('REVIEW', 1, { exitCriteria: 'Review the code in a separate adversarial agent.' }),
    step('DONE', 2, { isAnchor: true, role: 'closing' }),
  ],
};

function resetCommanderOptions(cmd: any) {
  for (const opt of (cmd as any).options || []) cmd.setOptionValue(opt.attributeName(), undefined);
  (cmd.commands || []).forEach(resetCommanderOptions);
}

describe('flow show warnings (CGLAB-457)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
    program.commands.forEach(resetCommanderOptions);
    program.setOptionValue('toon', undefined);
  });

  it('prints each warning under the table, and says a hub admin can change a hub flow', async () => {
    mockedAxios.get.mockResolvedValue({ data: UNCHECKED });
    vi.spyOn(console, 'table').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'agenfk', 'flow', 'show', 'flow-1']);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('⚠️');
    expect(out).toMatch(/REVIEW/);
    expect(out).toMatch(/role 'review'/);
    expect(out).toMatch(/hub admin/);
    logSpy.mockRestore();
  });

  it('adds contractWarnings to --json', async () => {
    mockedAxios.get.mockResolvedValue({ data: UNCHECKED });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'agenfk', 'flow', 'show', 'flow-1', '--json']);
    const out = JSON.parse(logSpy.mock.calls.flat().join('\n'));
    expect(out.contractWarnings).toEqual([expect.objectContaining({ step: 'REVIEW', kind: 'review' })]);
    logSpy.mockRestore();
  });

  it('prints no warning for a flow that enforces what it asks for', async () => {
    const enforced = { ...UNCHECKED, steps: UNCHECKED.steps.map(s => (s.name === 'REVIEW' ? { ...s, role: 'review' } : s)) };
    mockedAxios.get.mockResolvedValue({ data: enforced });
    vi.spyOn(console, 'table').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'agenfk', 'flow', 'show', 'flow-1']);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('⚠️');
    logSpy.mockRestore();
  });
});
