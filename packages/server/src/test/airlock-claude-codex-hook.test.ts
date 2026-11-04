import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-ignore — a plain ESM hook script with no type declarations
import { judgeHookCall, argsOfToolInput } from '../../../../bin/agenfk-airlock-hook.mjs';
// @ts-ignore
import * as realAirlock from '../../../../bin/agenfk-airlock.mjs';

// GH-356: Claude Code's and Codex's PreToolUse hook. It judges a tool call through the shared
// agenfk-airlock.mjs ONLY inside the Airlock sandbox (AGENFK_AIRLOCK_SANDBOX claude/codex). Outside
// it nothing is judged and nothing is gated, even when the policy enforces and covers the session:
// unlike pi and OpenCode, running Claude Code or Codex in Airlock is not required.

const SCRIPT = path.resolve(__dirname, '../../../../bin/agenfk-airlock-hook.mjs');
const DENY = { decision: 'deny', rule: 'builtin-metadata-deny', reason: 'cloud metadata endpoint' };

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-airlock-hook-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A state file saying the policy enforces and covers every session: what would gate pi. */
function enforcingState(): string {
  const f = path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ mode: 'enforce', revision: 4, models: [], appliesWhenModelUnknown: true }));
  return f;
}

const bash = (command: string, over: Record<string, unknown> = {}) => ({
  session_id: 'sess-9', cwd: '/work/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...over,
});

/** The shared script, with its server call faked. */
function airlock(answer: unknown) {
  return { ...realAirlock, requestVerdict: vi.fn(async () => answer) };
}
const ok = (verdict: unknown) => ({ status: 'ok', verdict, mode: 'enforce', applies: true, revision: 4, source: 'local' });

describe('outside the sandbox: nothing is judged, nothing is gated', () => {
  it.each([[undefined], ['pi'], ['opencode'], ['command'], ['']])('marker %s: no verdict asked, the call goes ahead, even under an enforcing policy', async (marker) => {
    const a = airlock(ok(DENY));
    const env = marker === undefined ? {} : { AGENFK_AIRLOCK_SANDBOX: marker };
    expect(await judgeHookCall(bash('curl http://169.254.169.254/'), { env, airlock: a, stateFile: enforcingState() })).toBeNull();
    expect(a.requestVerdict).not.toHaveBeenCalled();
  });

  it('run as a hook outside the sandbox, it prints nothing and exits 0', () => {
    const env = { ...process.env, HOME: tmp };
    delete (env as Record<string, unknown>).AGENFK_AIRLOCK_SANDBOX;
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(bash('curl http://169.254.169.254/')), env, encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe.each(['claude', 'codex'] as const)('inside the sandbox (%s)', (client) => {
  const env = { AGENFK_AIRLOCK_SANDBOX: client, AGENFK_AIRLOCK_MODEL: 'anthropic/claude-opus-5-5' };

  it('asks for a verdict with its client, model, tool, arguments, session and folder', async () => {
    const a = airlock(ok({ decision: 'allow' }));
    expect(await judgeHookCall(bash('curl https://x.example'), { env, airlock: a, stateFile: enforcingState() })).toBeNull();
    expect(a.requestVerdict).toHaveBeenCalledWith({
      client, model: { provider: 'anthropic', id: 'claude-opus-5-5' }, toolName: 'Bash',
      args: { command: 'curl https://x.example' }, sessionId: 'sess-9', cwd: '/work/repo',
    });
  });

  it('a deny is a PreToolUse deny with Airlock\'s reason', async () => {
    const out = await judgeHookCall(bash('curl http://169.254.169.254/'), { env, airlock: airlock(ok(DENY)), stateFile: enforcingState() });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/agenfk airlock[\s\S]*metadata/) } });
  });

  it('a call held for a person\'s approval is stopped too, saying so', async () => {
    const held = { decision: 'needs-human-approval', rule: 'cloudMutation', reason: 'mutates cloud', approvalKey: 'k1', capabilities: [] };
    const out = await judgeHookCall(bash('aws s3 rm s3://x'), { env, airlock: airlock(ok(held)), stateFile: enforcingState() });
    expect(out?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toMatch(/approv/i);
  });

  it('a call carrying no command, path or URL is not sent', async () => {
    const a = airlock(ok(DENY));
    expect(await judgeHookCall({ ...bash(''), tool_name: 'TodoWrite', tool_input: { todos: [] } }, { env, airlock: a, stateFile: enforcingState() })).toBeNull();
    expect(a.requestVerdict).not.toHaveBeenCalled();
  });

  it('a server it cannot reach blocks under an enforcing, covering policy (the shared rule), and allows otherwise', async () => {
    const down = { status: 'unreachable', reason: 'ECONNREFUSED' };
    const blocked = await judgeHookCall(bash('ls'), { env, airlock: airlock(down), stateFile: enforcingState() });
    expect(blocked?.hookSpecificOutput.permissionDecision).toBe('deny');
    const observe = path.join(tmp, 'observe.json');
    fs.writeFileSync(observe, JSON.stringify({ mode: 'observe', revision: 1, models: [] }));
    expect(await judgeHookCall(bash('ls'), { env, airlock: airlock(down), stateFile: observe })).toBeNull();
  });

  it('never applies a launch gate: an allowed call goes ahead though nothing proves confinement', async () => {
    const a = { ...airlock(ok({ decision: 'allow' })), airlockSandboxCheck: vi.fn(async () => ({ sandboxed: false, reason: 'no marker' })) };
    expect(await judgeHookCall(bash('ls'), { env, airlock: a, stateFile: enforcingState() })).toBeNull();
    expect(a.airlockSandboxCheck).not.toHaveBeenCalled();
  });
});

describe('argsOfToolInput: what each tool carries, by the keys the server judges', () => {
  it.each([
    ['Bash', { command: 'ls -la', description: 'list' }, { command: 'ls -la', description: 'list' }],
    ['Read', { file_path: '/etc/passwd' }, { file_path: '/etc/passwd' }],
    ['Write', { file_path: '/w/a.ts', content: 'x' }, { file_path: '/w/a.ts', content: 'x' }],
    ['WebFetch', { url: 'https://x.example', prompt: 'p' }, { url: 'https://x.example', prompt: 'p' }],
    ['Grep', { pattern: 'k', path: '/home/u/.aws' }, { pattern: 'k', path: '/home/u/.aws' }],
  ])('%s', (_tool, input, args) => {
    expect(argsOfToolInput(input)).toEqual(args);
  });

  it('a non-object tool_input is no arguments', () => {
    expect(argsOfToolInput(null)).toEqual({});
    expect(argsOfToolInput('ls')).toEqual({});
  });
});
