/**
 * 37a292a7 (story e6e34594, CGLAB-164): `agenfk gatekeeper` says what leaving
 * the card's step will run, so the agent does not run the suite first when
 * verify will - and knows the tests are its own when verify runs none.
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
const CARD = { id: 'c1c1c1c1-0000-0000-0000-000000000000', title: 'The card', type: 'TASK', status: 'MAKE', projectId: 'p1' };
const FLOW = { id: 'f1', name: 'F', steps: [
  { name: 'START', order: 0, isAnchor: true }, { name: 'MAKE', order: 1, role: 'coding' },
  { name: 'CHECK', order: 2, role: 'review' }, { name: 'END', order: 3, isAnchor: true },
] };
const PLAN = {
  step: 'MAKE', next: 'CHECK', runs: 'suite', checks: ['suite-green'], entryBaseline: null, narrowing: [], waitsOnPerson: false,
  advice: "Leaving MAKE runs the project's suite for you (suite-green). Don't run the full suite yourself first.",
};

function resetCommanderOptions(cmd: any) {
  (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

let out: string[];
let spies: Array<{ mockRestore: () => void }>;
let cwd: string;
let tmp: string;

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
  // Out of this repo's own .agenfk project, so the card's project is the one in play.
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-gk-'));
  process.chdir(tmp);
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  mockedAxios.get.mockReset();
});

function server(plan: unknown | Error) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/items')) return { data: [CARD] } as any;
    if (url.endsWith('/projects/p1/flow')) return { data: FLOW } as any;
    if (url.endsWith('/projects/p1')) return { data: { id: 'p1', projectRoot: null } } as any;
    if (url.endsWith(`/items/${CARD.id}/leave-plan`)) {
      if (plan instanceof Error) throw plan;
      return { data: plan } as any;
    }
    throw new Error(`unexpected ${url}`);
  });
}

async function gatekeeper(...extra: string[]) {
  try { await program.parseAsync(['node', 'agenfk', 'gatekeeper', '--intent', 'x', '--item-id', CARD.id, ...extra]); } catch (e: any) { if (e?.message !== 'exit') throw e; }
  return out.join('\n');
}
/** The one JSON line --json prints (the stubbed exit throws into the command's catch, which prints after it). */
const jsonOf = (text: string) => JSON.parse(text.split('\n').find(l => l.startsWith('{')) ?? 'null');

describe('agenfk gatekeeper: what leaving the step runs', () => {
  it("prints the leave plan's advice after the step contract", async () => {
    server(PLAN);
    const text = await gatekeeper();
    expect(text).toMatch(/AUTHORIZED/);
    expect(text).toContain(PLAN.advice);
  });

  it('--json carries the plan as leavePlan', async () => {
    server(PLAN);
    const json = jsonOf(await gatekeeper('--json'));
    expect(json.authorized).toBe(true);
    expect(json.leavePlan).toMatchObject({ step: 'MAKE', runs: 'suite', checks: ['suite-green'] });
  });

  it('a server that cannot answer the plan does not stop the authorization (leavePlan null)', async () => {
    server(new Error('404'));
    const json = jsonOf(await gatekeeper('--json'));
    expect(json.authorized).toBe(true);
    expect(json.leavePlan).toBeNull();
  });
});

describe('agenfk flow show --json: each step carries what leaving it runs', () => {
  // leavePlan, not onLeave: the flow contract already uses onLeave for the resolved checks.
  it("merges the project's per-step plans in as leavePlan", async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('/projects/p1/flow/leave-plans')) return { data: [{ step: 'MAKE', runs: 'suite', checks: ['suite-green'] }, { step: 'CHECK', runs: 'verify-command', checks: [] }] } as any;
      if (url.includes('/projects/p1/flow')) return { data: FLOW } as any;
      throw new Error(`unexpected ${url}`);
    });
    try { await program.parseAsync(['node', 'agenfk', 'flow', 'show', '--project', 'p1', '--json']); } catch (e: any) { if (e?.message !== 'exit') throw e; }
    const shown = JSON.parse(out.join('\n'));
    const by = Object.fromEntries(shown.steps.map((st: any) => [st.name, st.leavePlan?.runs ?? null]));
    expect(by).toEqual({ START: null, MAKE: 'suite', CHECK: 'verify-command', END: null });
  });
});
