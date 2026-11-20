/**
 * @vitest-environment node
 *
 * INFRA-425: herdr's variables stay out of every terminal, not only the attach.
 *
 * The desktop app inherits its environment from whoever launched it. Launched
 * from a terminal inside a herdr pane, it carried HERDR_PANE_ID and friends
 * into every shell it opened — and `herdr` run in one of those shells answered
 * "nested herdr is disabled by default" and exited, although nothing was
 * nested: the shell belonged to this app, not to herdr. Measured on a real
 * machine on 2026-10-06. The attach already stripped them; a shell did not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyRegistry } from '../main/ptyRegistry';

let envs: NodeJS.ProcessEnv[];
const saved: Record<string, string | undefined> = {};
const HERDR = { HERDR_PANE_ID: 'p1', HERDR_ENV: '1', HERDR_SOCKET_PATH: '/run/herdr.sock' };

beforeEach(() => {
  envs = [];
  for (const [k, v] of Object.entries(HERDR)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterEach(() => {
  for (const k of Object.keys(HERDR)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const registry = () => new PtyRegistry({
  spawn: vi.fn((_file: string, _args: unknown, opts: { env: NodeJS.ProcessEnv }) => {
    envs.push(opts.env);
    return {
      pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {},
      pause: () => {}, resume: () => {},
    };
  }) as never,
  resolveCwd: async () => ({ cwd: '/tmp/wt', branchName: 'feat/x' }),
  emit: () => {},
});

describe('herdr variables in a terminal this app opens', () => {
  it('are not passed to a plain shell', async () => {
    await registry().spawn({ agentId: 'shell', windowId: 1, cols: 80, rows: 24 } as never);
    expect(Object.keys(envs[0]).filter(k => k.toUpperCase().startsWith('HERDR'))).toEqual([]);
  });

  it('are not passed to an agent on a card', async () => {
    await registry().spawn({ itemId: 'i1', agentId: 'claude-code', windowId: 1, cols: 80, rows: 24 });
    expect(Object.keys(envs[0]).filter(k => k.toUpperCase().startsWith('HERDR'))).toEqual([]);
  });

  it('leave everything else in place', async () => {
    process.env.AGENFK_SOMETHING_ELSE = 'kept';
    try {
      await registry().spawn({ agentId: 'shell', windowId: 1, cols: 80, rows: 24 } as never);
      expect(envs[0].AGENFK_SOMETHING_ELSE).toBe('kept');
    } finally {
      delete process.env.AGENFK_SOMETHING_ELSE;
    }
  });
});
