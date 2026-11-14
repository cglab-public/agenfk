/**
 * Which project a folder belongs to (CGLAB-625).
 *
 * `projectId` is a row id in ONE machine's database. Committed, it was wrong
 * everywhere else: a teammate's clone pointed at a project their database did
 * not have, and two clones on one machine silently became one project with one
 * root. So the id lives in `.agenfk/local.json`, which is git-ignored, and
 * `.agenfk/project.json` carries only what the repository shares.
 *
 * A repository from before the split still has its id in project.json. It keeps
 * working - reported as 'legacy', so a caller can say how to move it.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The machine-only file under `.agenfk/`. */
export const LOCAL_PROJECT_FILE = 'local.json';

export interface ProjectIdentity {
  /** The directory holding `.agenfk/`. */
  readonly root: string;
  /** Null for a project this machine has not linked yet (a fresh clone). */
  readonly projectId: string | null;
  /** Where the id came from: local.json, or a legacy id in project.json. */
  readonly source: 'local' | 'legacy' | null;
}

/** The id local.json names, or null. Never throws: the file is hand-editable. */
export function readLocalProjectFile(raw: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const id = (parsed as Record<string, unknown>).projectId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** A small regular file's text, or null: a FIFO here would block a sync read for ever. */
function readSmallFile(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** The nearest `.agenfk` at or above `startDir` holding either file, and what it says. */
function nearest(startDir: string): ProjectIdentity | null {
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.agenfk');
    const local = readSmallFile(path.join(marker, LOCAL_PROJECT_FILE));
    const shared = readSmallFile(path.join(marker, 'project.json'));
    if (local !== null || shared !== null) {
      const fromLocal = local !== null ? readLocalProjectFile(local) : null;
      if (fromLocal) return { root: dir, projectId: fromLocal, source: 'local' };
      // The same reading local.json gets: only an id, never settings.
      const legacy = shared !== null ? readLocalProjectFile(shared) : null;
      if (legacy) return { root: dir, projectId: legacy, source: 'legacy' };
      return { root: dir, projectId: null, source: null };
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * When `dir` is inside a linked worktree of a non-bare repository: the
 * worktree's top and the main checkout. Read from the worktree's `.git` FILE
 * (`gitdir: <main>/.git/worktrees/<name>`), never by running git.
 */
export function linkedWorktreeOf(dir: string): { top: string; main: string } | null {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    const dotGit = path.join(cur, '.git');
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(dotGit); } catch { /* none here */ }
    if (st && !st.isFile()) return null; // a main checkout's .git directory (or a link): not a worktree
    if (st?.isFile()) {
      const text = st.size <= 4096 ? readSmallFile(dotGit) : null;
      const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
      if (!m) return null;
      const gitDir = path.resolve(cur, m[1]);
      const common = path.dirname(path.dirname(gitDir));
      // A submodule's .git points into modules/; a bare repository named .git has no checkout.
      if (path.basename(path.dirname(gitDir)) !== 'worktrees' || path.basename(common) !== '.git') return null;
      const config = readSmallFile(path.join(common, 'config'));
      if (config && /^\s*bare\s*=\s*true\s*$/mi.test(config)) return null;
      return { top: cur, main: path.dirname(common) };
    }
    if (path.dirname(cur) === cur) return null;
  }
}

/**
 * The nearest project at or above `startDir`: the first `.agenfk/` holding
 * local.json or project.json. Its id comes from local.json first, else from a
 * legacy projectId in project.json. Null outside any project.
 *
 * IN A LINKED WORKTREE, local.json is never there - it is git-ignored, so it
 * does not travel into one - but the worktree is the same project on the same
 * machine. When the worktree names no id of its own, the main checkout's
 * matching directory answers, and `root` stays the worktree's.
 */
export function resolveProjectIdentity(startDir: string): ProjectIdentity | null {
  const found = nearest(startDir);
  const wt = linkedWorktreeOf(startDir);
  // A marker inside the worktree that names an id settles it; one found ABOVE
  // the worktree belongs to some enclosing directory, not to this checkout.
  const ownMarker = !!found && !!wt && within(found.root, wt.top);
  if (!wt || (ownMarker && found!.projectId)) return found;
  const from = path.join(wt.main, path.relative(wt.top, ownMarker ? found!.root : path.resolve(startDir)));
  const there = nearest(from);
  if (there?.projectId && within(there.root, wt.main)) {
    return { root: path.join(wt.top, path.relative(wt.main, there.root)), projectId: there.projectId, source: there.source };
  }
  return found;
}

/** `p` is `dir` or lies under it, by whole path segments. */
function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + path.sep);
}
