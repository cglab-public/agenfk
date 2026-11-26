/**
 * Story 76da75ea (INFRA-463), review round 1: the default dependencies of
 * discoverHub(). The DNS name must not depend on the directory `hub login`
 * runs in, so the global git identity is read first; the health probe must
 * vouch for the origin it was given, so it follows no redirect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: any[]) => execFileMock(...a) }));
const getMock = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: any[]) => getMock(...a) } }));

import { discoverHub } from '../hub/discovery';

/** execFile fake answering by the exact git arguments. */
function gitAnswers(byArgs: Record<string, string>) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _o: any, cb: (e: any, out: string) => void) => {
    const key = args.join(' ');
    if (key in byArgs) cb(null, byArgs[key] + '\n');
    else cb(Object.assign(new Error('exit 1'), { code: 1 }), '');
  });
}

const noFiles = async (p: string) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); };

beforeEach(() => {
  execFileMock.mockReset();
  getMock.mockReset();
});

describe('default gitEmail', () => {
  it('reads the global identity first, so the DNS name does not depend on the current repo', async () => {
    gitAnswers({ 'config --global --get user.email': 'dev@acme.com', 'config --get user.email': 'other@elsewhere.org' });
    const names: string[] = [];
    await discoverHub({
      env: {}, platform: 'linux', homedir: () => '/home/dev', readFile: noFiles,
      resolveTxt: async (n) => { names.push(n); return []; },
    });
    expect(names).toEqual(['_agenfk-hub.acme.com']);
  });

  it('falls back to the repository identity when no global one is set', async () => {
    gitAnswers({ 'config --get user.email': 'dev@acme.com' });
    const names: string[] = [];
    await discoverHub({
      env: {}, platform: 'linux', homedir: () => '/home/dev', readFile: noFiles,
      resolveTxt: async (n) => { names.push(n); return []; },
    });
    expect(names).toEqual(['_agenfk-hub.acme.com']);
  });
});

describe('default httpGet', () => {
  it('follows no redirect and passes the 3 s timeout to the request', async () => {
    getMock.mockResolvedValue({ status: 200, data: { service: 'agenfk-hub' } });
    const r = await discoverHub({
      env: { AGENFK_HUB_URL: 'https://hub.acme.com' }, platform: 'linux', homedir: () => '/home/dev', readFile: noFiles,
    });
    expect(r).toMatchObject({ url: 'https://hub.acme.com', source: 'env' });
    expect(getMock).toHaveBeenCalledTimes(1);
    const [url, opts] = getMock.mock.calls[0];
    expect(url).toBe('https://hub.acme.com/healthz');
    expect(opts.maxRedirects).toBe(0);
    expect(opts.timeout).toBe(3000);
  });
});
