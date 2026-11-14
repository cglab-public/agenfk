import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { killProcessTree } from './killTree.js';

/**
 * A project's git origin URL, for hub events (#208 review).
 *
 * Bounded at 1.5 s: it runs on the request path and per project in the flow
 * sync poller, and a git that hangs (network mount, credential prompt) must not
 * hold either. A lookup that timed out is answered as "no remote" but marked
 * not cacheable - cached, one slow first lookup on a loaded box shipped every
 * later event of the project without its remoteUrl. The timeout ends the whole
 * tree: on Windows git.exe is a wrapper, and a plain kill left the real git
 * running in the project's root, holding it open. A lookup git did not answer
 * (it could not start, or failed otherwise than "no origin" / "not a
 * repository") is not cacheable either: Airlock's per-project overrides fail
 * closed on it rather than read it as "no remote" (PO-1).
 */
export interface RemoteLookupDeps {
  /** `failed`: git did not answer - it could not start, or exited with an error other than "no origin" / "not a repository". */
  run: (root: string, timeoutMs: number, args?: string[]) => Promise<{ out: string; timedOut: boolean; failed?: boolean }>;
}

const GET_URL = ['remote', 'get-url', 'origin'];


/** git's own "there is none": no such remote (get-url: 2; config --get: 1), or no repository here (128, read in the C locale). */
const gitSaysNone = (code: number | null, err: string): boolean =>
  code === 2 || code === 1 || (code === 128 && /not a git repository/i.test(err));

const TIMEOUT_MS = 1500;

const defaults: RemoteLookupDeps = {
  run: (root, timeoutMs, args = GET_URL) => new Promise(resolve => {
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    const finish = (text: string, failed = false) => { if (done) return; done = true; clearTimeout(timer); resolve({ out: text, timedOut, failed }); };
    const child = spawn('git', args, {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LC_ALL: 'C' },
    });
    const timer = setTimeout(() => { timedOut = true; killProcessTree(child); finish(''); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 4096) err += d.toString(); });
    child.on('error', () => finish('', true));
    child.on('close', code => (code === 0 ? finish(out) : finish('', !gitSaysNone(code, err))));
  }),
};

/**
 * One call per key at a time: callers that arrive while it runs share its
 * promise, and the next caller after it settles (success or not) starts a new
 * one. A verify that closes a card emits two hub events back to back; each
 * started its own remote lookup, and a late timeout overwrote the URL the other
 * had just cached (review of f94e1694).
 */
export function oneInFlight<K>(fn: (key: K) => Promise<void>): (key: K) => Promise<void> {
  const running = new Map<K, Promise<void>>();
  return (key) => {
    const current = running.get(key);
    if (current) return current;
    const p = fn(key).finally(() => running.delete(key));
    running.set(key, p);
    return p;
  };
}

/**
 * How long to remember an answer: a real one (a URL, or git saying there is
 * none) for good - undefined; a timed-out one for a minute. Forgotten at once,
 * every event of a slow project waited the full timeout again.
 */
export function remoteCacheLifetimeMs(answer: { cacheable: boolean }): number | undefined {
  return answer.cacheable ? undefined : 60_000;
}

export async function readRemoteUrl(root: string, deps: RemoteLookupDeps = defaults, args: string[] = GET_URL): Promise<{ url: string; cacheable: boolean }> {
  const { out, timedOut, failed } = await deps.run(root, TIMEOUT_MS, args);
  // A failed lookup is asked again like a timed-out one, never remembered as "no remote".
  return { url: out.trim(), cacheable: !timedOut && !failed };
}

/**
 * Airlock's read (PO-1): the origin <root>/.git/config records, read as that
 * one file (`git config --file`: no commondir, no includes, no url rewrites, no
 * config.worktree), the nearest .git at or above the root as git finds it.
 * A sandbox cannot write .git/config, but it can move .git away and plant
 * another, or write .git/commondir (measured on macOS), so: no .git at all is
 * no repository; a .git that is not a real directory, or a
 * config that is not a regular file, is a failed lookup. airlockRepoPins pins
 * the answer where no sandbox can write.
 */
export async function readAirlockRemoteUrl(root: string, deps: RemoteLookupDeps = defaults): Promise<{ url: string; cacheable: boolean }> {
  // The nearest .git at or above the root, as git's own discovery finds it (a
  // project may sit below its checkout's root).
  let dir = path.resolve(root);
  let gitDir: fs.Stats | null = null;
  for (;;) {
    try {
      gitDir = fs.lstatSync(path.join(dir, '.git'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return { url: '', cacheable: false };
    }
    const up = path.dirname(dir);
    if (up === dir) return { url: '', cacheable: true };
    dir = up;
  }
  const config = path.join(dir, '.git', 'config');
  let file: fs.Stats | null = null;
  try { file = fs.lstatSync(config); } catch { file = null; }
  if (!gitDir.isDirectory() || !file?.isFile()) return { url: '', cacheable: false };
  return readRemoteUrl(root, deps, ['config', '--file', config, '--get', 'remote.origin.url']);
}
