import path from 'path';
import { spawn } from 'child_process';

/**
 * Kill a command the server spawned, with everything it started (#208).
 *
 * Off Windows the server spawns a command in its own process group, and a
 * negative pid kills the group - also after the shell exited, since a runner's
 * workers can outlive it (a leftover one could write the NEXT capture's
 * report). A command that is not a group leader has no such group; the kill
 * throws and the child itself is killed, as before.
 *
 * On Windows there are no process groups - the negative pid always threw, and
 * only cmd.exe died while npm, vitest and their workers ran on. `taskkill /T`
 * ends the whole tree, started without blocking the server (it takes ~0.5 s);
 * when it fails the child itself is killed. Only while the child is alive:
 * /T walks from a live root, and a dead pid may already be someone else's.
 * Workers left behind by a shell that exited normally are out of its reach -
 * a Job Object would be the tool for that.
 */
export interface KillTreeDeps {
  platform: NodeJS.Platform;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  /** Start ending `pid` and its descendants; call `onFailed` when that did not happen. */
  taskkill: (pid: number, onFailed: () => void) => void;
}

const defaults: KillTreeDeps = {
  platform: process.platform,
  killPid: (pid, signal) => { process.kill(pid, signal); },
  taskkill: (pid, onFailed) => {
    const exe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const tk = spawn(exe, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    tk.on('error', onFailed);
    tk.on('exit', code => { if (code !== 0) onFailed(); });
  },
};

export function killProcessTree(
  child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal?: NodeJS.Signals) => boolean },
  deps: KillTreeDeps = defaults,
): void {
  const killChild = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  if (!child.pid) { killChild(); return; }
  if (deps.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    deps.taskkill(child.pid, killChild);
    return;
  }
  try { deps.killPid(-child.pid, 'SIGKILL'); } catch { killChild(); }
}
