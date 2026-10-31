/**
 * 6386d4ac: which process a recorded pid is. A pid alone is reused - after a crash, and always
 * after a reboot - so a record naming one could be taken for a process that is long gone. With it,
 * Airlock records the boot the process runs in and when it started; a live pid with another of
 * those is another process.
 */
import fs from 'fs';
import { spawnSync } from 'child_process';

let bootOf: string | null | undefined;

/** This boot: Linux's boot id, macOS's boot time. Null where neither can be read. */
function boot(): string | null {
  if (bootOf !== undefined) return bootOf;
  if (process.platform === 'linux') {
    try { bootOf = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { bootOf = null; }
  } else {
    const r = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = r.status === 0 ? /sec = (\d+), usec = (\d+)/.exec(r.stdout) : null;
    bootOf = m ? `${m[1]}.${m[2]}` : null;
  }
  return bootOf;
}

/**
 * When `pid` started: Linux's clock ticks since boot (/proc/<pid>/stat), else ps's start time - to
 * the second, which a reused pid would have to wrap every pid within to match.
 */
function started(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // After the command, which is in parentheses and may hold anything: field 22 is the 20th.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
      return null;
    }
  }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const t = r.status === 0 ? r.stdout.trim() : '';
  return t ? t.replace(/\s+/g, '_') : null;
}

/** The identity of the process `pid` is now (`<boot>/<start>`, no spaces), or null when it is gone or cannot be read. */
export function processIdentity(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const b = boot();
  const s = started(pid);
  return b && s ? `${b}/${s}` : null;
}

/**
 * Is the recorded process the one running now? Its pid is alive, and - when the record has an
 * identity and the running one's can be read - the same identity. A record from before identities
 * were kept is judged by its pid, as it was.
 */
export function sameProcess(
  rec: { pid: number; identity?: string | null },
  d: { pidAlive: (pid: number) => boolean; identityOf: (pid: number) => string | null },
): boolean {
  if (!Number.isInteger(rec.pid) || rec.pid <= 0 || !d.pidAlive(rec.pid)) return false;
  if (!rec.identity) return true;
  const now = d.identityOf(rec.pid);
  return now === null || now === rec.identity;
}
