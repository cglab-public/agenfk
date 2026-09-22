/**
 * Bringing back the answer of a subprocess — which is all "run it on the
 * screen" ever was.
 *
 * The version this replaced opened an interactive agent in a pty and read the
 * answer out of the terminal scroll, for a question with one answer and no
 * follow-up.
 */
import { describe, it, expect, vi } from 'vitest';
import { proposeDecomposition, PROPOSE_TIMEOUT_MS } from '../main/propose';

const deps = (over: Record<string, unknown> = {}) => ({
  resolveProjectCwd: vi.fn(async () => ({ cwd: '/checkout' })),
  fetchContract: vi.fn(async (o: string) => `CONTRACT about ${o}`),
  printCommand: vi.fn(() => ({ file: 'claude', args: ['-p', 'CONTRACT'] })),
  run: vi.fn(async () => ({ stdout: '{"objective":"x","items":[]}', stderr: '' })),
  ...over,
});

const req = { projectId: 'p1', agentId: 'claude-code', objective: 'port the admin API' };

it('asks the agent the contract, in the project checkout', async () => {
  const d = deps();
  await proposeDecomposition(req, d as never);
  expect(d.fetchContract).toHaveBeenCalledWith('port the admin API');
  expect(d.printCommand).toHaveBeenCalledWith('claude-code', 'CONTRACT about port the admin API');
  expect(d.run).toHaveBeenCalledWith('claude', ['-p', 'CONTRACT'], { cwd: '/checkout', timeoutMs: PROPOSE_TIMEOUT_MS });
});

it('returns what the agent printed, untouched', async () => {
  // Parsing belongs to the screen, which already has a tested extractor. Two
  // parsers of the same output would drift.
  const { stdout } = await proposeDecomposition(req, deps() as never);
  expect(stdout).toBe('{"objective":"x","items":[]}');
});

it('names the agent that cannot be asked, instead of failing vaguely', async () => {
  // "cannot" sends someone hunting for a bug; the agent's name sends them to
  // pick another one.
  const d = deps({ printCommand: () => null });
  await expect(proposeDecomposition({ ...req, agentId: 'gemini' }, d as never))
    .rejects.toThrow(/gemini/);
});

it('refuses an empty objective before spawning anything', async () => {
  const d = deps();
  await expect(proposeDecomposition({ ...req, objective: '  ' }, d as never)).rejects.toThrow(/objective/i);
  expect(d.run).not.toHaveBeenCalled();
});

it('explains a silent agent with its own stderr', async () => {
  // Exit zero and nothing on stdout is a failure, and stderr is the only place
  // that says why — not logged in, rate limited, model unavailable. Returning
  // "" would make the screen blame the answer instead of the run.
  const d = deps({ run: async () => ({ stdout: '   ', stderr: 'Invalid API key\nrun `claude login`' }) });
  await expect(proposeDecomposition(req, d as never)).rejects.toThrow(/claude login/);
});

it('does not ask the agent when the project has nowhere to run', async () => {
  const d = deps({ resolveProjectCwd: async () => { throw new Error('no projectRoot'); } });
  await expect(proposeDecomposition(req, d as never)).rejects.toThrow(/projectRoot/);
  expect(d.run).not.toHaveBeenCalled();
});
