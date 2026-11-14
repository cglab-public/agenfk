/**
 * The machine-only half of a project's files (CGLAB-625).
 *
 * `.agenfk/project.json` is the repository's shared settings, committed.
 * `.agenfk/local.json` is `{ projectId }` - a row id in this machine's
 * database - and must never be committed: in a teammate's clone it names a
 * project their database does not have, and two clones on one machine become
 * one project with one root.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { LOCAL_PROJECT_FILE } from '@agenfk/core';

export const LOCAL_FILE_REL = `.agenfk/${LOCAL_PROJECT_FILE}`;

/** Write `{ projectId }` to `<dir>/.agenfk/local.json`. */
export function writeLocalProjectId(dir: string, projectId: string): string {
  const file = path.join(dir, '.agenfk', LOCAL_PROJECT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ projectId }, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Make git ignore `<dir>/.agenfk/local.json`.
 *
 * Asks git first (`check-ignore --no-index`), so a rule already covering it -
 * `.agenfk/`, a global excludes file - is left alone. Otherwise the entry goes
 * in `<dir>/.gitignore`, which is committed: every clone then ignores its own
 * local.json, which `.git/info/exclude` would do for this clone only.
 */
export function ensureLocalIgnored(dir: string): 'already' | 'added' | 'not-git' {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', LOCAL_FILE_REL], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return 'already';
  } catch (e: any) {
    // 1 = not ignored. Anything else (128: not a repository; ENOENT: no git) means nothing to ignore it from.
    if (e?.status !== 1) return 'not-git';
  }
  const file = path.join(dir, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // The file's own line ending: a CRLF .gitignore stays CRLF.
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const sep = current && !current.endsWith('\n') ? eol : '';
  fs.writeFileSync(file, `${current}${sep}${LOCAL_FILE_REL}${eol}`, 'utf8');
  return 'added';
}

/** Whether git tracks `<dir>/.agenfk/project.json`: only then is there a change to commit. */
export function projectFileTracked(dir: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '.agenfk/project.json'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

/** The projectId `<dir>/.agenfk/project.json` still carries, read without changing anything. */
export function readLegacyProjectId(dir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, '.agenfk', 'project.json'), 'utf8'));
    const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.projectId : undefined;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch { return null; }
}

/**
 * Remove a string projectId from `<dir>/.agenfk/project.json`, keeping every
 * other key. Returns the id it removed, or null - touching nothing - when
 * there was none it could read as an id.
 *
 * A file left with nothing in it stays, as `{}`: it is committed, and in every
 * other clone it is the marker the hooks find the project by. Deleting it took
 * the edit guard away from each of them on their next pull.
 */
export function stripLegacyProjectId(dir: string): string | null {
  const id = readLegacyProjectId(dir);
  if (!id) return null;
  const file = path.join(dir, '.agenfk', 'project.json');
  const { projectId: _gone, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify(rest, null, 2) + '\n', 'utf8');
  return id;
}
