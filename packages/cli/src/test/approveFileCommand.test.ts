/**
 * 34ee6b8a: `agenfk approve-file-command` used to read ~/.agenfk/verify-token
 * and approve the repository's command itself - the same token the agent's
 * CLI holds, so an agent refused COMMAND_NEEDS_APPROVAL could approve and run
 * the command it was refused. Approving is a person's act, on the board; the
 * CLI shows what there is to approve and says where.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) {
    this.capture = vi.fn();
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.isEnabled = false;
    this.id = 'test-install-id';
  }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
let out: string[];
let spies: Array<{ mockRestore: () => void }>;
let root: string;

beforeEach(() => {
  out = [];
  // eslint-disable-next-line no-control-regex
  const capture = (...a: any[]) => { out.push(a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '')); };
  spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any),
  ];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-approve-'));
  fs.mkdirSync(path.join(root, '.agenfk'));
  fs.writeFileSync(path.join(root, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p1', verifyCommand: 'echo from-the-repo' }));
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/projects/p1')) return { data: { id: 'p1', projectRoot: root } } as any;
    throw new Error(`unexpected ${url}`);
  });
  mockedAxios.post.mockResolvedValue({ data: { approved: true, fingerprint: 'f' } } as any);
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
});

async function run(...args: string[]) {
  try { await program.parseAsync(['node', 'agenfk', 'approve-file-command', ...args]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}

describe('agenfk approve-file-command', () => {
  it('never approves, even with --yes: it shows the command and sends a person to the board', async () => {
    const text = await run('p1', '--yes');
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(text).toContain('echo from-the-repo');
    expect(text).toMatch(/on the board/i);
  });

  it('says the same without --yes', async () => {
    const text = await run('p1');
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(text).toMatch(/on the board/i);
  });
});
