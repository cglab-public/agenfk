/**
 * Resolve an agent-run sourcePath into a concrete file path.
 *
 * The pi worker session JSONL is named `<ISO-timestamp>_<session-id>.jsonl`,
 * and the timestamp is minted at pi launch — unknown when the orchestrator
 * registers the run. So a run may be registered with a `~`/glob pattern keyed
 * on the deterministic session-id (a glob such as ~/.pi/agent/sessions/<cwd>/<ts>_<sid>.jsonl)
 * and the live tailer resolves it to the newest matching file once pi writes it.
 *
 * - No `~` and no `*`  -> returned unchanged (exact path; existence not checked,
 *   the caller already tolerates ENOENT).
 * - Leading `~`        -> expanded against the home dir.
 * - Contains `*`       -> matched against the filesystem; the most-recently
 *   modified match is returned, or `undefined` when nothing matches.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ResolveOpts {
  home?: string;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

function segmentToRegExp(seg: string): RegExp {
  const escaped = seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

export function resolveSourcePath(pattern: string, opts: ResolveOpts = {}): string | undefined {
  if (!pattern) return undefined;
  const home = opts.home ?? os.homedir();
  const expanded = expandHome(pattern, home);

  if (!expanded.includes('*')) return expanded;

  const segments = expanded.split(path.sep);
  let candidates: string[] = [expanded.startsWith(path.sep) ? path.sep : '.'];

  for (const seg of segments) {
    if (seg === '') continue;
    if (!seg.includes('*')) {
      candidates = candidates.map((c) => path.join(c, seg));
      continue;
    }
    const re = segmentToRegExp(seg);
    const next: string[] = [];
    for (const dir of candidates) {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        if (re.test(entry)) next.push(path.join(dir, entry));
      }
    }
    candidates = next;
  }

  const stated = candidates
    .map((c) => {
      try {
        const st = fs.statSync(c);
        return st.isFile() ? { path: c, mtimeMs: st.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtimeMs: number } => x !== null);
  if (stated.length === 0) return undefined;

  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stated[0].path;
}
