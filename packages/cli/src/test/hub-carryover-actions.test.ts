/**
 * Story e3068dce (CGLAB-117): REAL action tests for `agenfk hub carry-over`
 * and `agenfk hub deadletter [discard]` — sandboxed HOME, mocked axios and
 * readline, following the hub-repoint.test.ts pattern. These pin the behavior
 * the source-scan tests can only allude to: refusal matrix, the exact rewrite
 * body, the audit line, confirmation gating, and file-level discard semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerHubCommands } from '../commands/hub';

const { sandboxHome } = vi.hoisted(() => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  return { sandboxHome: fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-carryover-')) };
});
const realHome = process.env.HOME;
// HOME is (re-)assigned in a global beforeEach for plain vitest; under
// stryker's in-process runner os.homedir() ignores process.env.HOME entirely,
// so the os module itself is mocked below — belt and braces.
beforeEach(() => { process.env.HOME = sandboxHome; });

const { mockGet, mockPost, askState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  askState: { answer: '', lastQuestion: '' },
}));
vi.mock('axios', () => ({ default: { get: mockGet, post: mockPost } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => sandboxHome };
});
vi.mock('@agenfk/telemetry', () => ({
  getApiUrl: () => 'http://localhost:3000',
  getInstallationId: () => 'inst-test',
}));
vi.mock('readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => { askState.lastQuestion = _q; cb(askState.answer); },
    close: () => { /* noop */ },
  }),
}));

// The commands refuse confirmation without a TTY (review F8); pretend to have
// one by default so the prompt path is exercised. Individual tests flip it.
const realIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
function setTty(v: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
}

const AGENFK_DIR = path.join(sandboxHome, '.agenfk');
const HUB_CONFIG = path.join(AGENFK_DIR, 'hub.json');
const VERIFY_TOKEN = path.join(AGENFK_DIR, 'verify-token');
const DEADLETTER = path.join(AGENFK_DIR, 'hub-deadletter.jsonl');
const AUDIT = path.join(AGENFK_DIR, 'hub-audit.jsonl');

const CURRENT = { url: 'https://hub.acme.com', token: 'tok-acme', orgId: 'acme' };

function seed(opts: { config?: boolean; token?: boolean } = {}): void {
  fs.mkdirSync(AGENFK_DIR, { recursive: true });
  if (opts.config !== false) fs.writeFileSync(HUB_CONFIG, JSON.stringify(CURRENT, null, 2), { mode: 0o600 });
  if (opts.token !== false) fs.writeFileSync(VERIFY_TOKEN, 'verifytok\n');
}

function seedDeadletter(lines: Array<{ eventId: string; orgId?: string; occurredAt: string; reason: string }>): void {
  fs.mkdirSync(AGENFK_DIR, { recursive: true });
  fs.writeFileSync(DEADLETTER, lines.map(l => JSON.stringify({
    eventId: l.eventId, occurredAt: l.occurredAt, deadletteredAt: l.occurredAt,
    reason: l.reason, payload: { eventId: l.eventId, ...(l.orgId ? { orgId: l.orgId } : {}) },
  })).join('\n') + '\n', { mode: 0o600 });
}

const statusWith = (orgs: unknown) => mockGet.mockImplementation(async (url: string, opts: any) => {
  if (url.includes('/internal/hub/status')) {
    if (opts?.headers?.['x-agenfk-internal'] !== 'verifytok') throw new Error('bad internal token');
    return { status: 200, data: { enabled: true, outboxDepth: 3, orgs } };
  }
  throw new Error(`unexpected GET ${url}`);
});

const OLD_CORP_SUMMARY = {
  count: 3, firstOccurredAt: '2026-01-01T00:00:00Z', lastOccurredAt: '2026-01-09T00:00:00Z',
  // Deliberately NOT in sorted-by-count order: the summary must sort desc.
  types: { 'item.closed': 1, 'item.created': 2 },
};

async function run(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(args, { from: 'user' });
}

describe('agenfk hub carry-over (actions)', () => {
  let program: Command;
  let exitSpy: any;
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHubCommands(program);
    for (const f of [HUB_CONFIG, DEADLETTER, AUDIT]) { try { fs.unlinkSync(f); } catch { /* */ } }
    seed();
    mockGet.mockReset(); mockPost.mockReset();
    askState.answer = ''; askState.lastQuestion = '';
    setTty(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (realIsTTY) Object.defineProperty(process.stdin, 'isTTY', realIsTTY);
    else delete (process.stdin as any).isTTY;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  });

  it('refuses missing --from/--to without touching the server', async () => {
    await expect(run(program, ['hub', 'carry-over', '--from', 'x'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/--from and --to are required/);
    // Fresh program: commander keeps option state across parses on one instance.
    program = new Command();
    program.exitOverride();
    registerHubCommands(program);
    await expect(run(program, ['hub', 'carry-over', '--to', 'y'])).rejects.toThrow('exit 1');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refuses from === to without touching the server', async () => {
    await expect(run(program, ['hub', 'carry-over', '--from', 'x', '--to', 'x'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/same org/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses when no outbox rows carry --from', async () => {
    statusWith({ acme: { count: 1, firstOccurredAt: 'a', lastOccurredAt: 'b', types: {} } });
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/no queued events stamped org "old-corp"/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('--yes rewrites ONLY the stated from->to and audits {at,from,to,rewritten,osUser}', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY, other: { count: 9, firstOccurredAt: 'a', lastOccurredAt: 'b', types: {} } });
    mockPost.mockImplementation(async (url: string, body: any, config: any) => {
      expect(url).toContain('/internal/hub/rewrite-outbox-org');
      expect(body).toEqual({ from: 'old-corp', to: 'acme' });
      expect(config?.headers?.['x-agenfk-internal']).toBe('verifytok');
      return { status: 200, data: { ok: true, rewritten: 3 } };
    });
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes']);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const audit = fs.readFileSync(AUDIT, 'utf8').trim().split('\n');
    expect(audit).toHaveLength(1);
    const line = JSON.parse(audit[0]);
    expect(line).toMatchObject({ from: 'old-corp', to: 'acme', rewritten: 3 });
    expect(typeof line.at).toBe('string');
    expect(typeof line.osUser).toBe('string');
    expect(fs.statSync(AUDIT).mode & 0o777).toBe(0o600);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/3 queued event\(s\)/);
    expect(out).toMatch(/Time range : 2026-01-01T00:00:00Z \.\. 2026-01-09T00:00:00Z/);
    expect(out).toMatch(/Event types: item\.created \(2\), item\.closed \(1\)/);
    expect(out).toMatch(/TENANCY WATERMARK/);
    expect(out).toMatch(/moves data across an org boundary/);
    expect(out).toMatch(/Carried over 3 event\(s\) from "old-corp" to "acme" \(audited\)/);
  });

  it('carrying over to the configured org shows the flush hint and no undeliverable warning', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 3 } });
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/agenfk hub flush/);
    expect(out).not.toMatch(/STILL not deliverable/);
  });

  it('prints no Event types line when the source org has none', async () => {
    statusWith({ 'old-corp': { count: 1, firstOccurredAt: 'x', lastOccurredAt: 'y', types: {} } });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 1 } });
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes']);
    expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/Event types:/);
  });

  it('aborts WITHOUT rewriting when the typed confirmation does not match', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    askState.answer = '  not-the-target  ';
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme']);
    expect(askState.lastQuestion).toMatch(/acme/);
    expect(askState.lastQuestion).toMatch(/from "old-corp"/);
    expect(mockPost).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Aborted/);
  });

  it('typed TARGET-org confirmation proceeds with the rewrite (whitespace tolerated)', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 3 } });
    askState.answer = '  acme  ';
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme']);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('refuses interactive confirmation without a TTY instead of hanging', async () => {
    setTty(false);
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/not a TTY/);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Review the summary above, then re-run with --yes/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('trims padded --from/--to before matching and rewriting', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockImplementation(async (_url: string, body: any) => {
      expect(body).toEqual({ from: 'old-corp', to: 'acme' });
      return { status: 200, data: { ok: true, rewritten: 3 } };
    });
    await run(program, ['hub', 'carry-over', '--from', '  old-corp  ', '--to', '  acme  ', '--yes']);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('flags when the set-based rewrite count differs from the confirmed snapshot', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 2 } });
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes']);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/summary showed 3 event\(s\) but 2 were rewritten/);
  });

  it('SHOUTS when the rewrite succeeded but the audit write fails, and exits 1', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 3 } });
    fs.chmodSync(AGENFK_DIR, 0o500); // audit append now hits EACCES for real
    try {
      await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
      const err = errSpy.mock.calls.flat().join(' ');
      expect(err).toMatch(/REWRITE SUCCEEDED \(3 event\(s\)\) BUT THE AUDIT LINE FAILED TO WRITE/);
      expect(err).toMatch(/EACCES|permission/i);
      expect(err).toMatch(/Append it manually to .+hub-audit\.jsonl/);
      expect(mockPost).toHaveBeenCalledTimes(1);
    } finally {
      fs.chmodSync(AGENFK_DIR, 0o700);
    }
  });

  it('refuses when the status payload carries no orgs at all', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { enabled: true } });
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/no queued events stamped org "old-corp"/);
  });

  it('survives a status response with no data field', async () => {
    mockGet.mockResolvedValue({ status: 200 });
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/no queued events stamped org "old-corp"/);
  });

  it('warns when the target org is not the org these credentials deliver to', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 3 } });
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'third-org', '--yes']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/credentials are for org "acme"/);
    expect(out).toMatch(/STILL not deliverable/);
  });

  it('shows no flush hint when there is no hub config to compare against', async () => {
    try { fs.unlinkSync(HUB_CONFIG); } catch { /* */ }
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockResolvedValue({ status: 200, data: { ok: true, rewritten: 3 } });
    await run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes']);
    expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/agenfk hub flush/);
  });

  it('surfaces the axios error message when the server is unreachable', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { message: 'connect ECONNREFUSED' }));
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Cannot read the local outbox \(connect ECONNREFUSED\)/);
  });

  it('refuses without a verify-token (server unreachable)', async () => {
    try { fs.unlinkSync(VERIFY_TOKEN); } catch { /* */ }
    seed({ config: true, token: false });
    await expect(run(program, ['hub', 'carry-over', '--from', 'a', '--to', 'b', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/verify-token/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a failed rewrite exits 1 and writes NO audit line', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockRejectedValue(Object.assign(new Error('boom'), { response: { data: { error: 'server exploded' } } }));
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Carry-over failed: server exploded/);
    expect(fs.existsSync(AUDIT)).toBe(false);
  });

  it('reports the plain error when a rewrite fails without a response body', async () => {
    statusWith({ 'old-corp': OLD_CORP_SUMMARY });
    mockPost.mockRejectedValue(new Error('socket hang up'));
    await expect(run(program, ['hub', 'carry-over', '--from', 'old-corp', '--to', 'acme', '--yes'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Carry-over failed: socket hang up/);
  });
});

describe('agenfk hub deadletter (actions)', () => {
  let program: Command;
  let exitSpy: any;
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHubCommands(program);
    for (const f of [HUB_CONFIG, DEADLETTER, AUDIT]) { try { fs.unlinkSync(f); } catch { /* */ } }
    askState.answer = ''; askState.lastQuestion = '';
    setTty(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (realIsTTY) Object.defineProperty(process.stdin, 'isTTY', realIsTTY);
    else delete (process.stdin as any).isTTY;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  });

  const THREE = [
    { eventId: 'a', orgId: 'old-corp', occurredAt: '2026-01-01T00:00:00Z', reason: 'org_mismatch' },
    { eventId: 'b', orgId: 'old-corp', occurredAt: '2026-01-05T00:00:00Z', reason: 'hidden_user' },
    { eventId: 'c', orgId: 'other-org', occurredAt: '2026-02-01T00:00:00Z', reason: 'invalid' },
  ];

  it('lists entries grouped by org with counts, range and reasons', async () => {
    seedDeadletter(THREE);
    await run(program, ['hub', 'deadletter']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/Org old-corp — 2 event\(s\)/);
    expect(out).toMatch(/2026-01-01T00:00:00Z \.\. 2026-01-05T00:00:00Z/);
    expect(out).toMatch(/org_mismatch \(1\), hidden_user \(1\), reasons:|reasons: org_mismatch \(1\), hidden_user \(1\)/);
    expect(out).toMatch(/Org other-org — 1 event\(s\)/);
    expect(out).toMatch(/Total: 3 line\(s\) in .+hub-deadletter\.jsonl — discard/);
  });

  it('a discarded file still lists correctly (writer/reader round trip)', async () => {
    seedDeadletter(THREE);
    await run(program, ['hub', 'deadletter', 'discard', '--org', 'old-corp']);
    logSpy.mockClear();
    await run(program, ['hub', 'deadletter']);
    const out = logSpy.mock.calls.flat().join(' ');
    expect(out).toMatch(/Org other-org — 1 event\(s\)/);
    expect(out).toMatch(/Total: 1 line\(s\)/);
  });

  it('preserves unparseable lines through --org discard; --all removes them', async () => {
    seedDeadletter(THREE);
    fs.appendFileSync(DEADLETTER, 'TORN-LINE-WITHOUT-JSON\n');
    await run(program, ['hub', 'deadletter', 'discard', '--org', 'old-corp']);
    const left = fs.readFileSync(DEADLETTER, 'utf8');
    expect(left).toContain('TORN-LINE-WITHOUT-JSON');
    expect(left).toContain('other-org');
    logSpy.mockClear();
    await run(program, ['hub', 'deadletter']);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/1 unparseable line\(s\)/);
    await run(program, ['hub', 'deadletter', 'discard', '--all', '--yes']);
    expect(fs.existsSync(DEADLETTER)).toBe(false);
  });

  it('distinguishes an empty deadletter file from a missing one', () => {
    fs.mkdirSync(AGENFK_DIR, { recursive: true });
    fs.writeFileSync(DEADLETTER, '', { mode: 0o600 });
    program.parseAsync(['hub', 'deadletter'], { from: 'user' });
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/No deadlettered events \(file is empty\)/);
  });

  it('says so when there is nothing deadlettered', async () => {
    await run(program, ['hub', 'deadletter']);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/No deadlettered events/);
  });

  it('discard --org removes ONLY that org and keeps the rest on disk', async () => {
    seedDeadletter(THREE);
    await run(program, ['hub', 'deadletter', 'discard', '--org', 'old-corp']);
    const left = fs.readFileSync(DEADLETTER, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(left.map(e => e.eventId)).toEqual(['c']);
    expect(fs.statSync(DEADLETTER).mode & 0o777).toBe(0o600);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Discarded 2 deadlettered entries; 1 remain/);
  });

  it('discard singularizes for exactly one entry', async () => {
    seedDeadletter([THREE[2]]);
    await run(program, ['hub', 'deadletter', 'discard', '--org', 'other-org']);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Discarded 1 deadlettered entry; 0 remain/);
    expect(fs.existsSync(DEADLETTER)).toBe(false);
  });

  it('discard on an absent file says there is nothing to discard', async () => {
    await run(program, ['hub', 'deadletter', 'discard', '--all']);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Nothing to discard/);
  });

  it('discard --org that matches nothing changes nothing and says so', async () => {
    seedDeadletter(THREE);
    await run(program, ['hub', 'deadletter', 'discard', '--org', 'nope']);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/No deadlettered entries match — nothing discarded/);
    expect(fs.readFileSync(DEADLETTER, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('discard --all without confirmation aborts and changes nothing', async () => {
    seedDeadletter(THREE);
    askState.answer = 'nope';
    await run(program, ['hub', 'deadletter', 'discard', '--all']);
    expect(askState.lastQuestion).toMatch(/discard all/);
    expect(fs.readFileSync(DEADLETTER, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Aborted/);
  });

  it("typed 'discard all' confirmation removes every entry (file unlinked)", async () => {
    seedDeadletter(THREE);
    askState.answer = 'discard all';
    await run(program, ['hub', 'deadletter', 'discard', '--all']);
    expect(fs.existsSync(DEADLETTER)).toBe(false);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Discarded 3/);
  });

  it('discard --all --yes needs no prompt', async () => {
    seedDeadletter(THREE);
    await run(program, ['hub', 'deadletter', 'discard', '--all', '--yes']);
    expect(askState.lastQuestion).toBe('');
    expect(fs.existsSync(DEADLETTER)).toBe(false);
  });

  it('discard --all without a TTY refuses instead of hanging on EOF stdin', async () => {
    setTty(false);
    seedDeadletter(THREE);
    await expect(run(program, ['hub', 'deadletter', 'discard', '--all'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/not a TTY/);
    expect(fs.existsSync(DEADLETTER)).toBe(true);
  });

  it('--all wins over --org when both are given', async () => {
    seedDeadletter(THREE);
    await run(program, ['hub', 'deadletter', 'discard', '--org', 'old-corp', '--all', '--yes']);
    expect(fs.existsSync(DEADLETTER)).toBe(false);
  });

  it('discard with neither --org nor --all exits 1', async () => {
    seedDeadletter(THREE);
    await expect(run(program, ['hub', 'deadletter', 'discard'])).rejects.toThrow('exit 1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Choose --org <orgId> or --all/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(DEADLETTER)).toBe(true);
  });
});
