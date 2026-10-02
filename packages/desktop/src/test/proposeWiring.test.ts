/**
 * The wiring between the main process and the server, which is where the
 * screen's first real error came from.
 *
 * `httpGet` resolves to { status, contentType, body }. Stringifying that
 * response produced the literal "[object Object]", and the user watched
 * `JSON.parse` say so on screen — through an error path built to surface the
 * agent's own words, reporting instead a defect in the plumbing.
 */
import { describe, it, expect, vi } from 'vitest';
import { proposeDecomposition } from '../main/propose';

/** The real shape of an httpGet answer. */
const response = (body: string, status = 200) => ({ status, contentType: 'application/json', body });

const depsFor = (get: (path: string) => unknown) => ({
  resolveProjectCwd: async (projectId: string) => {
    const res = get(`/projects/${projectId}`) as { status: number; body: string } | null;
    if (!res || res.status >= 300) throw new Error('no project');
    const root = JSON.parse(res.body || '{}')?.projectRoot;
    if (typeof root !== 'string' || !root) throw new Error('This project has no projectRoot');
    return { cwd: root };
  },
  fetchContract: async (objective: string) => {
    const res = get(`/decompositions/contract?objective=${objective}`) as { status: number; body: string } | null;
    if (!res || res.status >= 300 || !res.body.trim()) throw new Error('no contract');
    return res.body;
  },
  printCommand: () => ({ file: 'claude', args: ['-p', 'C'] }),
  run: vi.fn(async () => ({ stdout: '{"objective":"x","items":[]}', stderr: '' })),
});

it('reads the BODY of a response, not the response', async () => {
  const deps = depsFor(path =>
    path.startsWith('/projects') ? response('{"projectRoot":"/checkout"}') : response('CONTRACT'));
  await expect(proposeDecomposition({ projectId: 'p1', agentId: 'claude-code', objective: 'x' }, deps as never))
    .resolves.toMatchObject({ stdout: expect.stringContaining('objective') });
  expect(deps.run).toHaveBeenCalledWith('claude', ['-p', 'C'], expect.objectContaining({ cwd: '/checkout' }));
});

it('says which project has nowhere to run, instead of a parser error', async () => {
  const deps = depsFor(path => path.startsWith('/projects') ? response('{}') : response('CONTRACT'));
  await expect(proposeDecomposition({ projectId: 'p1', agentId: 'claude-code', objective: 'x' }, deps as never))
    .rejects.toThrow(/projectRoot/);
  expect(deps.run).not.toHaveBeenCalled();
});

it('does not run the agent when the contract never arrived', async () => {
  const deps = depsFor(path =>
    path.startsWith('/projects') ? response('{"projectRoot":"/checkout"}') : response('', 500));
  await expect(proposeDecomposition({ projectId: 'p1', agentId: 'claude-code', objective: 'x' }, deps as never))
    .rejects.toThrow(/contract/);
  expect(deps.run).not.toHaveBeenCalled();
});
