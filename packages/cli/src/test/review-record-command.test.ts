/** @file CGLAB-381 (S5-T1) — CLI review record + verify actor. */
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
vi.mock('figlet', () => ({
  default: { textSync: vi.fn().mockReturnValue('AgEnFK') },
}));
const mockInquirerPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: { prompt: mockInquirerPrompt },
}));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const API = 'http://localhost:3000';

function resetCommanderOptions(cmd: any) {
  const options = (cmd as any).options || [];
  options.forEach((opt: any) => {
    cmd.setOptionValue(opt.attributeName(), undefined);
  });
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}');
  program.commands.forEach(resetCommanderOptions);
  program.setOptionValue('toon', undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});


/**
 * CGLAB-381 (S5-T1): `agenfk review record` sends the transcript, range and
 * findings to the server, which reads the reviewer's identity from the
 * transcript. `agenfk verify` reports the author identity from the harness
 * environment (never from a flag an agent could fill in).
 */
describe('agenfk review record <id>', () => {
  it('POSTs transcript, range and parsed findings to /items/:id/review-records', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('tok');
    mockedAxios.post.mockResolvedValue({ status: 201, data: { id: 'r1', reviewer: { client: 'claude-code', sessionId: 's', agentId: 'a' }, findings: [] } });
    await program.parseAsync([
      'node', 'agenfk', 'review', 'record', 'item-1',
      '--transcript', '/home/x/.claude/projects/p/s/subagents/agent-a.jsonl',
      '--range', 'abc..def',
      '--findings', '[{"title":"t","state":"fixed"}]',
    ]);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${API}/items/item-1/review-records`,
      { transcript: '/home/x/.claude/projects/p/s/subagents/agent-a.jsonl', range: 'abc..def', findings: [{ title: 't', state: 'fixed' }] },
      expect.objectContaining({ headers: expect.objectContaining({ 'x-agenfk-internal': expect.anything() }) }),
    );
  });

  it('refuses findings that are not JSON, without calling the server', async () => {
    await program.parseAsync(['node', 'agenfk', 'review', 'record', 'item-1', '--transcript', 't', '--range', 'a..b', '--findings', 'not json']);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('agenfk verify reports the author identity', () => {
  const ID = '11111111-2222-3333-4444-555555555555';
  it('sends actor { client, sessionId } from CLAUDE_CODE_SESSION_ID', async () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-xyz';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('tok');
    mockedAxios.post.mockResolvedValue({ status: 200, data: { message: 'ok' } });
    try {
      await program.parseAsync(['node', 'agenfk', 'verify', ID, '--evidence', 'e']);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
    const call = mockedAxios.post.mock.calls.find(c => String(c[0]).endsWith(`/items/${ID}/validate`));
    expect(call?.[1]).toMatchObject({ actor: { client: 'claude-code', sessionId: 'sess-xyz' } });
  });
});
