/**
 * @file CGLAB-457 (T1) — `agenfk review record` with the range left to the
 * server, and a transcript refusal that lists the candidates.
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
const mockInquirerPrompt = vi.fn();
const { mockSubagentTranscripts } = vi.hoisted(() => ({ mockSubagentTranscripts: vi.fn() }));
vi.mock('../reviewTranscripts', () => ({ subagentTranscripts: mockSubagentTranscripts }));
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



const transcript = '/home/x/.claude/projects/p/s/subagents/agent-a.jsonl';

describe('agenfk review record without --range (CGLAB-457)', () => {
  it("sends range 'auto', leaving the range to the server", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('tok');
    mockedAxios.post.mockResolvedValue({ status: 201, data: { id: 'r1', reviewer: { client: 'claude-code', sessionId: 's', agentId: 'a' }, range: { from: 'a'.repeat(40), to: 'b'.repeat(40), auto: true }, findings: [] } });
    await program.parseAsync(['node', 'agenfk', 'review', 'record', 'item-1', '--transcript', transcript, '--findings', '[]']);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${API}/items/item-1/review-records`,
      { transcript, range: 'auto', findings: [] },
      expect.anything(),
    );
    expect(process.exit).not.toHaveBeenCalledWith(1);
    // The range the server worked out is shown, so the author sees what was recorded.
    expect(logSpy.mock.calls.flat().join('\n')).toContain(`${'a'.repeat(12)}..${'b'.repeat(12)}`);
  });

  it('still sends an explicit range as given', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('tok');
    mockedAxios.post.mockResolvedValue({ status: 201, data: { id: 'r1', findings: [] } });
    await program.parseAsync(['node', 'agenfk', 'review', 'record', 'item-1', '--transcript', transcript, '--range', 'abc..def', '--findings', '[]']);
    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({ range: 'abc..def' });
  });
});

describe('agenfk review record refused over its transcript (CGLAB-457)', () => {
  it("lists this session's sub-agent transcripts, and records none of them itself", async () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-xyz';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('tok');
    mockSubagentTranscripts.mockReturnValue([
      { path: '/h/.claude/projects/p/sess-xyz/subagents/agent-r.jsonl', prompt: 'You are an independent reviewer', mtime: '2026-10-02T10:00:00.000Z' },
      { path: '/h/.claude/projects/p/sess-xyz/subagents/agent-e.jsonl', prompt: 'Explore the code', mtime: '2026-10-02T09:00:00.000Z' },
    ]);
    mockedAxios.post.mockRejectedValue({ response: { status: 400, data: { error: '/tmp/x.jsonl is not a transcript in a harness session folder (~/.claude/projects)' } } });
    const errSpy = vi.mocked(console.error);
    try {
      await program.parseAsync(['node', 'agenfk', 'review', 'record', 'item-1', '--transcript', '/tmp/x.jsonl', '--findings', '[]']);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
    expect(mockSubagentTranscripts).toHaveBeenCalledWith(expect.any(String), 'sess-xyz');
    const out = errSpy.mock.calls.flat().join('\n');
    expect(out).toContain('agent-r.jsonl');
    expect(out).toContain('You are an independent reviewer');
    expect(out).toContain('agent-e.jsonl');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('lists nothing on a refusal that is not about the transcript', async () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-xyz';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('tok');
    mockedAxios.post.mockRejectedValue({ response: { status: 400, data: { error: "finding 'x' is rejected without a reason" } } });
    try {
      await program.parseAsync(['node', 'agenfk', 'review', 'record', 'item-1', '--transcript', transcript, '--findings', '[{"title":"x","state":"rejected"}]']);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
    expect(mockSubagentTranscripts).not.toHaveBeenCalled();
  });
});
