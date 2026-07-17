/**
 * TDD for the CLI/MCP side of async validate runs (CGLAB-10).
 *
 * followValidateRun is the dependency-injected follow loop shared by
 * `agenfk verify` and the MCP validate_progress path: it polls a run until it
 * finishes, streams only NEW output, tolerates transient poll errors, and has
 * NO overall deadline — a verifyCommand may legitimately run for an hour.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { followValidateRun, type RunSnapshot } from '../verifyRun';

const ROOT = path.resolve(__dirname, '../../../..');

function seq(snapshots: Array<RunSnapshot | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const s = snapshots[Math.min(i++, snapshots.length - 1)];
    if (s instanceof Error) throw s;
    return s;
  });
}

describe('followValidateRun', () => {
  it('polls until the run leaves running and resolves with the final snapshot', async () => {
    const poll = seq([
      { status: 'running', output: '' },
      { status: 'running', output: 'building…\n' },
      { status: 'passed', output: 'building…\ndone\n', itemStatus: 'DONE' },
    ]);
    const res = await followValidateRun({ poll, onOutput: () => {}, intervalMs: 1 });
    expect(res.status).toBe('passed');
    expect(res.itemStatus).toBe('DONE');
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('streams only the incremental part of the output', async () => {
    const chunks: string[] = [];
    const poll = seq([
      { status: 'running', output: 'line1\n' },
      { status: 'running', output: 'line1\nline2\n' },
      { status: 'failed', output: 'line1\nline2\nline3\n' },
    ]);
    await followValidateRun({ poll, onOutput: c => chunks.push(c), intervalMs: 1 });
    expect(chunks).toEqual(['line1\n', 'line2\n', 'line3\n']);
  });

  it('has no overall deadline — hundreds of polls are fine', async () => {
    const snapshots: Array<RunSnapshot> = Array.from({ length: 300 }, () => ({ status: 'running' as const, output: '' }));
    snapshots.push({ status: 'passed', output: 'ok' });
    const poll = seq(snapshots);
    const res = await followValidateRun({ poll, onOutput: () => {}, intervalMs: 0 });
    expect(res.status).toBe('passed');
    expect(poll).toHaveBeenCalledTimes(301);
  });

  it('survives transient poll errors below the consecutive-error cap', async () => {
    const poll = seq([
      { status: 'running', output: '' },
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      { status: 'running', output: 'still here\n' },
      { status: 'passed', output: 'still here\nok\n' },
    ]);
    const res = await followValidateRun({ poll, onOutput: () => {}, intervalMs: 0, maxConsecutiveErrors: 5 });
    expect(res.status).toBe('passed');
  });

  it('gives up after maxConsecutiveErrors with a "may still be in progress" error', async () => {
    const poll = seq([new Error('ECONNREFUSED')]);
    await expect(
      followValidateRun({ poll, onOutput: () => {}, intervalMs: 0, maxConsecutiveErrors: 3 }),
    ).rejects.toThrow(/still be in progress/i);
    expect(poll).toHaveBeenCalledTimes(3);
  });
});

describe('async verify wiring — no more bounded single-POST verifies', () => {
  it('the CLI verify command requests an async run', () => {
    const src = readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
    expect(src).toMatch(/async:\s*true/);
    expect(src).toContain('followValidateRun');
  });

  it('the MCP validate path no longer relies on a 5-minute single request', () => {
    const src = readFileSync(path.join(ROOT, 'packages/server/src/index.ts'), 'utf8');
    expect(src).toMatch(/async:\s*true/);
    expect(src).not.toContain('timeout: 300000');
  });

  it('the CLI verify path no longer carries the 5-minute cap', () => {
    const src = readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
    expect(src).not.toContain('timeout: 300000');
  });
});
