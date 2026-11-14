/**
 * #260: `agenfk approve-file-command` stays so scripts get an answer, but a
 * verifyCommand the repository declares needs no approval any more. It shows
 * what the file declares, says there is nothing to approve, and names hidden
 * characters, which still keep a command from running.
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
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
});

async function run(...args: string[]) {
  // Commander keeps a command's option values between parses of one program: reset --yes, or a
  // later run without it inherits the earlier `yes: true` and tests nothing.
  program.commands.find(c => c.name() === 'approve-file-command')?.setOptionValue('yes', undefined);
  try { await program.parseAsync(['node', 'agenfk', 'approve-file-command', ...args]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}

describe('agenfk approve-file-command', () => {
  it('approves nothing and says nothing needs approving, even with --yes', async () => {
    const text = await run('p1', '--yes');
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(text).toContain('echo from-the-repo');
    expect(text).toMatch(/Nothing to approve: the verifyCommand runs as committed/);
    expect(text).not.toMatch(/on the board/i);
  });

  it('names hidden characters, which still keep the command from running', async () => {
    fs.writeFileSync(path.join(root, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p1', verifyCommand: 'npm test\u200B' }));
    const text = await run('p1');
    expect(text).toContain('U+200B');
    expect(text).not.toMatch(/Nothing to approve/);
  });

  it("says a file's setupCommand is not run here", async () => {
    fs.writeFileSync(path.join(root, '.agenfk', 'project.json'), JSON.stringify({ projectId: 'p1', setupCommand: 'make deps' }));
    const text = await run('p1');
    expect(text).toMatch(/setupCommand is not run on this machine/);
    expect(text).not.toMatch(/Nothing to approve/);
  });
});
