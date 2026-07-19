/**
 * TDD for the CLI/MCP side of async validate runs (CGLAB-10).
 *
 * followValidateRun is the dependency-injected follow loop shared by
 * `agenfk verify` and the MCP validate_progress path: it polls a run until it
 * finishes, streams only NEW output, tolerates transient poll errors, and has
 * NO overall deadline — a verifyCommand may legitimately run for an hour.
 */
import { describe, it, expect, vi } from 'vitest';
import { followValidateRun, type RunSnapshot } from '../verifyRun';

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

  it('rethrows fatal poll errors immediately (definitive 404, not a connection blip)', async () => {
    const fatal: any = new Error('Unknown run — server restarted; check the item comments.');
    fatal.fatal = true;
    const poll = seq([{ status: 'running', output: '' }, fatal]);
    await expect(
      followValidateRun({ poll, onOutput: () => {}, intervalMs: 0, maxConsecutiveErrors: 10 }),
    ).rejects.toThrow(/server restarted/i);
    expect(poll).toHaveBeenCalledTimes(2); // no retry burn on a definitive answer
  });
});

// NB: an "async verify wiring" describe block used to grep cli/index.ts and
// server/index.ts for `async: true` / `followValidateRun` / the absence of an
// overall timeout. Those were source-shape assertions of implementation details.
// The substantive contract — the follow loop polls until the run finishes,
// streams only new output, tolerates transient errors, and has NO overall
// deadline — is fully exercised behaviourally by the followValidateRun tests
// above (see "has no overall deadline — hundreds of polls are fine"). The greps
// were removed in the behaviour-based-testing conversion (CGLAB-16).
