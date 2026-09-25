import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { program } from '../index';
import axios from 'axios';
import * as childProcess from 'child_process';

const mockedAxios = vi.mocked(axios, true);

const FULL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';


/**
 * c857900e — `agenfk verify` on a card that waits only for a person's
 * approval: open the board on the card, wait for the go-ahead, and verify
 * again by itself, so the agent carries on without a chat message.
 */
const APPROVAL_ONLY = [
  { id: 'human-approval', outcome: 'fail', blocking: true, detail: 'waiting for a person to approve this step on the board' },
  { id: 'jira-key-valid', outcome: 'pass', blocking: false, detail: 'ABC-12' },
];
const refusal = (checks: unknown[]) => Object.assign(new Error('422'), { response: { status: 422, data: { message: '❌ Checks failed: the card cannot leave DISCOVERY yet.', checks } } });
const gates = (approvals: number) => ({ data: { step: 'DISCOVERY', approvalRequired: true, approvals: Array.from({ length: approvals }, (_, i) => ({ by: 'board', at: `2026-09-24T21:0${i}:00Z` })), overrides: {}, lastChecks: null } });
/**
 * GET answers by URL, never by call order: the CLI makes other GETs of its own
 * (the hub status), which would take a queued answer meant for the gates.
 * `gateSeq` is what successive /gates polls see; the last repeats.
 */
function serve(gateSeq: number[], run?: unknown) {
  let n = 0;
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (String(url).includes('/gates')) return gates(gateSeq[Math.min(n++, gateSeq.length - 1)]) as any;
    if (run && String(url).includes('/validate-runs/')) return { data: run } as any;
    return { data: {} } as any;
  });
}
const passed = { status: 200, data: { message: '✅ Validation Passed!\n\nItem moved to CREATE_UNIT_TESTS.' } };

describe('verify waits for a person\'s approval', () => {
  function resetCommanderOptions(cmd: any) {
    (cmd.options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
    (cmd.commands || []).forEach(resetCommanderOptions);
  }
  let exitSpy: any, logSpy: any, errSpy: any;
  const out = () => [...logSpy.mock.calls, ...errSpy.mock.calls].map((c: any[]) => c.join(' ')).join('\n');
  const opened = () => vi.mocked(childProcess.spawnSync).mock.calls.filter(c => (c[1] as string[] | undefined)?.includes('ui'));

  beforeEach(() => {
    vi.clearAllMocks();
    program.commands.forEach(resetCommanderOptions);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('test-token');
    // Queued one-off answers must not leak from one case into the next.
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    process.env.AGENFK_APPROVAL_POLL_MS = '1';
    delete process.env.CI;
    delete process.env.AGENFK_NO_BROWSER;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); delete process.env.AGENFK_APPROVAL_POLL_MS; });

  it('opens the board on the card, waits for the approval, and verifies again by itself', async () => {
    mockedAxios.post.mockRejectedValueOnce(refusal(APPROVAL_ONLY)).mockResolvedValueOnce(passed as any);
    serve([0, 0, 1]);
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'scope agreed']);
    expect(opened()).toHaveLength(1);
    expect(opened()[0][1]).toEqual(expect.arrayContaining(['ui', '--open', FULL_ID]));
    // c8e35fb8: the approval is given on the card's Overview, so open the card there.
    expect(opened()[0][1]).toContain('--details');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(out()).toMatch(/Approved on the board/);
    expect(out()).toMatch(/Item moved to CREATE_UNIT_TESTS/);
  });

  it('does not wait when another check blocks too: it fails at once, as before', async () => {
    mockedAxios.post.mockRejectedValueOnce(refusal([...APPROVAL_ONLY, { id: 'suite-green', outcome: 'fail', blocking: true, detail: '1 failing' }]));
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'x']);
    expect(opened()).toHaveLength(0);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('with --no-wait, neither opens the board nor waits, and says how to open it', async () => {
    mockedAxios.post.mockRejectedValueOnce(refusal(APPROVAL_ONLY));
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'x', '--no-wait']);
    expect(opened()).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out()).toContain(`agenfk ui --open ${FULL_ID} --details`);
  });

  it('in CI, neither opens a browser nor waits', async () => {
    process.env.CI = 'true';
    mockedAxios.post.mockRejectedValueOnce(refusal(APPROVAL_ONLY));
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'x']);
    expect(opened()).toHaveLength(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('gives up at the deadline and tells the agent to run the same verify again', async () => {
    mockedAxios.post.mockRejectedValueOnce(refusal(APPROVAL_ONLY));
    serve([0]);
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'x', '--wait-minutes', '0']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out()).toMatch(/Still waiting for a person's approval.*run the same agenfk verify again/s);
  });

  it('also waits when the refusal comes from a background run', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 202, data: { runId: 'run-1', message: '⏳ running' } } as any).mockResolvedValueOnce(passed as any);
    serve([0, 1], { status: 'failed', message: '❌ Checks failed', checks: APPROVAL_ONLY });
    await program.parseAsync(['node', 'agenfk', 'verify', FULL_ID, '--evidence', 'x']);
    expect(opened()).toHaveLength(1);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });
});
