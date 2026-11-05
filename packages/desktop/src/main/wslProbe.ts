/**
 * The wsl.exe calls behind distro listing and agent detection (INFRA-425).
 *
 * The process runner is injected, as detectAgents.ts injects `run`, so the
 * timeout, encoding and failure paths are tested without starting wsl.exe.
 */
import { parseDistroList, parseProbe, wslLaunch, WSL_PROBE_SCRIPT } from './wsl.js';

/** Runs a program; rejects on a non-zero exit, a timeout or a missing binary. */
export type WslRun = (
  file: string,
  args: readonly string[],
  opts: { encoding: 'buffer' | 'utf8'; timeout: number; windowsHide: true; env: NodeJS.ProcessEnv },
) => Promise<string | Buffer>;

export interface WslAgents {
  found: Set<string>;
  /** Every terminal runs in WSL (a distro is chosen): only the distro counts. */
  exclusive: boolean;
}

const WSL_DISTROS_MEMO_MS = 60_000;

export function createWslProbe(deps: {
  run: WslRun;
  exe: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  // WSL_UTF8 so a current wsl.exe prints UTF-8 whatever the caller set;
  // parseDistroList still reads UTF-16 from one that ignores it.
  const env = { ...deps.env, WSL_UTF8: '1' };
  let cache: { at: number; value: string[] } | null = null;

  const names = async (args: string[]): Promise<string[] | null> => {
    try {
      const out = await deps.run(deps.exe, args, { encoding: 'buffer', timeout: 5000, windowsHide: true, env });
      return parseDistroList(Buffer.isBuffer(out) ? out : Buffer.from(out));
    } catch {
      return null;
    }
  };

  /*
   * Only a SUCCESS is remembered. A failure — the VM still cold after boot, a
   * timeout — is asked again next time instead of hiding the person's distro
   * choice for a minute. Any failure reads as none installed.
   */
  async function listDistros(): Promise<string[]> {
    if (cache && now() - cache.at < WSL_DISTROS_MEMO_MS) return cache.value;
    const value = await names(['--list', '--quiet']);
    if (value === null) return [];
    cache = { at: now(), value };
    return value;
  }

  /** The distros running now, asked without starting anything. */
  async function listRunning(): Promise<string[]> {
    return (await names(['--list', '--running', '--quiet'])) ?? [];
  }

  /**
   * Which agent executables the distro terminals open in can find on its login
   * PATH, through the same login-shell wrapper the terminals use, so detection
   * and launch cannot disagree. One wsl.exe call for all of them.
   *
   * With a chosen distro every terminal runs there, so a failed probe still
   * answers `exclusive` with nothing found: falling back to the Windows PATH
   * would mark as installed an agent that dies inside Linux. Without a choice
   * a failure is null and the Windows side decides.
   */
  async function agentsIn(files: readonly string[], preference: string): Promise<WslAgents | null> {
    const distros = await listDistros();
    if (distros.length === 0) return null;
    const chosen = preference && distros.includes(preference) ? preference : null;
    let distro = chosen;
    if (!chosen) {
      /*
       * Only ask a distro that is ALREADY running: the probe runs a shell
       * inside it, which boots the WSL VM — memory a person who has WSL
       * installed but works in Windows should not pay on every refresh. The
       * AgEnFK server lives in WSL for the people this is for, so the VM is
       * up. One running distro is it; several, the default if it is among them.
       */
      const running = await listRunning();
      if (running.length === 1) distro = running[0];
      else if (running.length > 1 && running.includes(distros[0])) distro = null;
      else return null;
    }
    const probe = wslLaunch({
      distro,
      cwd: null,
      exe: deps.exe,
      command: { file: '/bin/sh', args: ['-c', WSL_PROBE_SCRIPT, 'probe', ...files] },
    });
    try {
      const out = await deps.run(probe.file, probe.args, { encoding: 'utf8', timeout: 15000, windowsHide: true, env });
      return { found: parseProbe(String(out), files), exclusive: Boolean(chosen) };
    } catch {
      return chosen ? { found: new Set(), exclusive: true } : null;
    }
  }

  return { listDistros, listRunning, agentsIn };
}
