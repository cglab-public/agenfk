/**
 * The "echo family" fixture repository (#311), from a per-worker template.
 *
 * Many specs build the same repository with
 *   git init -q -b main && git config user.email t@t && git config user.name t
 *   && echo a > a && git add . && git commit -qm one
 * (or `echo report.xml > .gitignore`, `echo a > marker`, ...). `echoRepo`
 * builds that once per worker per file set, via gitFixture's template cache,
 * and hands each caller its own copy - no shell and no git spawn once built.
 *
 * `files` maps each path to its content exactly as the shell wrote it: bash's
 * `echo a > a` writes "a\n". With no files the one commit is empty, as
 * `git commit -q --allow-empty -m one` made it. The key carries the files, so
 * different file sets never share a template. Clones share commit SHAs: a spec
 * that needs SHAs unique across repositories must build its own.
 */
import { cloneGitTemplate, gitSync, writeFiles, type GitTemplateBuild } from './gitFixture';

function buildFor(files: Record<string, string>): GitTemplateBuild {
  return (dir) => {
    gitSync(dir, 'init', '-q', '-b', 'main');
    gitSync(dir, 'config', 'user.email', 't@t');
    gitSync(dir, 'config', 'user.name', 't');
    if (Object.keys(files).length === 0) {
      gitSync(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
      return;
    }
    writeFiles(dir, files);
    gitSync(dir, 'add', '.');
    gitSync(dir, 'commit', '-qm', 'one');
  };
}

/**
 * A fresh copy of the repository on branch main, user t <t@t>, holding one
 * commit "one" of `files`, in a new temp directory named `<prefix>XXXXXX`
 * (long-form on Windows). The caller removes it.
 */
export function echoRepo(files: Record<string, string>, prefix?: string): string {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return cloneGitTemplate(`echo-repo:${JSON.stringify(sorted)}`, buildFor(sorted), prefix);
}

/** `echo a > a`: the commonest file set. */
export const A = { a: 'a\n' } as const;
/** `echo report.xml > .gitignore`. */
export const IGNORE_REPORT = { '.gitignore': 'report.xml\n' } as const;
