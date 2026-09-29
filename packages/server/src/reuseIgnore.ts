/**
 * 32045202 — what capture reuse leaves out of a tree's content.
 *
 * A docs edit changed the tree, so the next step re-ran the whole suite for
 * content no test reads. Reuse compares a second fingerprint that leaves out
 * the project's reuse-ignore globs (default: every Markdown file) - except a
 * file some test names, which a test may read (this repo's release test reads
 * CHANGELOG.md). A test that finds files some other way (listing a directory)
 * is the project's to declare: narrow the globs, or set [].
 */
import * as path from 'path';

export const DEFAULT_REUSE_IGNORE: readonly string[] = ['**/*.md'];

/** `**` crosses directories, `*` and `?` stay within one path segment. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const before = i === 0 || glob[i - 1] === '/';
      const after = glob[i + 2] === '/' || i + 2 === glob.length;
      if (before && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }
      if (before && after) { re = re.replace(/\/$/, ''); re += '(?:/.*)?'; i += 1; continue; }
      re += '.*'; i += 1; continue;
    }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Whether a tree-relative path matches any of the globs. */
export function reuseIgnoreMatcher(patterns: readonly string[]): (rel: string) => boolean {
  const res = patterns.map(globToRegExp);
  return rel => res.some(r => r.test(rel));
}

/**
 * The candidates some test's source names, so a test may read them: by file
 * name, or by a directory above them (6dd15e6e) - a test that lists a
 * directory reads every file in it. A directory counts when a test spells out
 * its path, or quotes its name as a string (`path.join(root, '.claude',
 * 'commands')`); the bare word in prose ("the docs") does not.
 */
export function namedByTests(candidates: readonly string[], testSources: readonly string[]): Set<string> {
  const named = new Set<string>();
  const says = (needle: string) => testSources.some(src => src.includes(needle));
  const quoted = (name: string) => says(`'${name}'`) || says(`"${name}"`) || says(`\`${name}\``);
  for (const c of candidates) {
    if (says(path.posix.basename(c))) { named.add(c); continue; }
    for (let dir = path.posix.dirname(c); dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) {
      if ((dir.includes('/') && says(dir)) || quoted(path.posix.basename(dir))) { named.add(c); break; }
    }
  }
  return named;
}
