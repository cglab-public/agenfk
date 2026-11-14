/**
 * 2ebacb23 (story e6e34594, CGLAB-164): `agenfk verify <id> --plan` - what
 * leaving the step will run on this tree, without running it or moving the card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  execSync: vi.fn(), execFileSync: vi.fn(() => ''), spawn: vi.fn(), spawnSync: vi.fn(),
  default: { execSync: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() },
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import { program } from '../index';
import axios from 'axios';

const mockedAxios = vi.mocked(axios, true);
const ID = 'c1c1c1c1-0000-0000-0000-000000000000';
const PLAN = {
  step: 'MAKE', next: 'CHECK', runs: 'suite', checks: ['suite-green'], entryBaseline: null, narrowing: ['reuse'], waitsOnPerson: false,
  advice: "Leaving MAKE runs the project's suite for you for suite-green. Don't run the full suite yourself first.",
  prediction: { mode: 'test-files', files: ['b.test.js'], advice: 'On this tree it would run only the changed test file b.test.js.' },
};

function resetCommanderOptions(cmd: any) {
  (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let out: string[];
let spies: Array<{ mockRestore: () => void }>;
beforeEach(() => {
  resetCommanderOptions(program);
  out = [];
  // eslint-disable-next-line no-control-regex
  const capture = (...a: any[]) => { out.push(a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '')); };
  spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any),
  ];
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith(`/items/${ID}/leave-plan?predict=1`)) return { data: PLAN } as any;
    throw new Error(`unexpected ${url}`);
  });
  mockedAxios.post.mockReset();
});
afterEach(() => { for (const s of spies) s.mockRestore(); mockedAxios.get.mockReset(); });

async function run(...args: string[]) {
  try { await program.parseAsync(['node', 'agenfk', 'verify', ID, ...args]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}

describe('agenfk verify --plan', () => {
  it('prints the plan and the prediction, needs no --evidence, and never posts a verify', async () => {
    const text = await run('--plan');
    expect(text).toContain(PLAN.advice);
    expect(text).toContain(PLAN.prediction.advice);
    expect(text).not.toMatch(/--evidence is required/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('--plan --json prints the plan as JSON', async () => {
    const text = await run('--plan', '--json');
    const json = JSON.parse(text.split('\n').find(l => l.startsWith('{')) ?? 'null');
    expect(json).toMatchObject({ runs: 'suite', prediction: { mode: 'test-files' } });
  });
});
