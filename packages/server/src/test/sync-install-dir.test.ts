import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
// The npx bootstrap (bin/agenfk.js) is dependency-light and cannot import
// @agenfk/core at clone time, so the prune lives in its own .mjs sibling and is
// exercised here directly — the same code the bootstrap runs.
// @ts-ignore — .mjs has no .d.ts
import { pruneInstallDir, pruneInstallDirAgainstManifest, isCaseInsensitive, PRUNED_DIRS } from '../../../../bin/sync-install-dir.mjs';

/**
 * Regression: ~/.agenfk-system was updated with a MERGE copy that never pruned
 * (bin/agenfk.js, `fs.cpSync(REPO_ROOT, INSTALL_DIR, { recursive: true })`).
 * A file deleted upstream therefore survived in the install dir forever, and
 * scripts/install.mjs copies every markdown out of `<rootDir>/commands` into
 * the user's global config — so the deleted file was re-installed on every
 * upgrade. The observed case: the repo-private /agenfk-release command moved
 * out of commands/ in July, yet was still landing in ~/.claude/commands/ in
 * September and leaking into unrelated projects.
 *
 * Pruning NEVER copies. Callers copy by their own means (fs.cpSync, `cp -r`,
 * `tar -xzf`) and prune afterwards.
 */

let src: string;
let dst: string;

function seed(root: string, rel: string, content = 'x\n'): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

beforeEach(() => {
  src = mkdtempSync(path.join(os.tmpdir(), 'agenfk-sync-src-'));
  dst = mkdtempSync(path.join(os.tmpdir(), 'agenfk-sync-dst-'));
});
afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(dst, { recursive: true, force: true });
});

describe('pruneInstallDir removes files deleted upstream', () => {
  it('removes a command the new version no longer ships (the /agenfk-release leak)', () => {
    seed(src, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md', 'stale repo-private release command\n');

    pruneInstallDir(src, dst);

    expect(existsSync(path.join(dst, 'commands/agenfk-release.md'))).toBe(false);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
  });

  it('prunes every synced source dir, not just commands/', () => {
    expect(PRUNED_DIRS.length).toBeGreaterThan(0);
    for (const dir of PRUNED_DIRS) {
      seed(src, `${dir}/kept.md`);
      seed(dst, `${dir}/kept.md`);
      seed(dst, `${dir}/dead.md`);
    }

    pruneInstallDir(src, dst);

    for (const dir of PRUNED_DIRS) {
      expect(existsSync(path.join(dst, dir, 'dead.md'))).toBe(false);
      expect(existsSync(path.join(dst, dir, 'kept.md'))).toBe(true);
    }
  });

  it('prunes nested files without destroying the directory that still has content', () => {
    seed(src, 'skills/claude-code/agenfk/SKILL.md');
    seed(dst, 'skills/claude-code/agenfk/SKILL.md');
    seed(dst, 'skills/claude-code/agenfk-release/SKILL.md');

    pruneInstallDir(src, dst);

    expect(existsSync(path.join(dst, 'skills/claude-code/agenfk-release'))).toBe(false);
    expect(existsSync(path.join(dst, 'skills/claude-code/agenfk/SKILL.md'))).toBe(true);
  });

  it('leaves dirs outside the pruned set alone, so the downloaded dist survives', () => {
    // packages/*/dist arrives from the release tarball and is absent from the
    // source tree — pruning it would break every upgrade.
    seed(src, 'commands/agenfk.md');
    seed(dst, 'packages/cli/dist/index.js', 'built\n');
    seed(dst, 'packages/server/dist/server.js', 'built\n');

    pruneInstallDir(src, dst);

    expect(existsSync(path.join(dst, 'packages/cli/dist/index.js'))).toBe(true);
    expect(existsSync(path.join(dst, 'packages/server/dist/server.js'))).toBe(true);
  });

  it('does not prune against a source dir that exists but is EMPTY', () => {
    // A truncated cp -r, a filtered copy or an aborted fetch leaves the dir
    // present and empty. Treating that as "nothing is shipped any more" wipes
    // the install wholesale. A plain existsSync guard does NOT catch this —
    // it was a surviving mutant until this test existed.
    mkdirSync(path.join(src, 'commands'), { recursive: true });
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-plan.md');

    const { removed } = pruneInstallDir(src, dst);

    expect(removed).toEqual([]);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
    expect(existsSync(path.join(dst, 'commands/agenfk-plan.md'))).toBe(true);
  });

  it('does not prune a dir the source fails to provide, so a partial source cannot wipe the install', () => {
    seed(src, 'skills/claude-code/agenfk/SKILL.md');
    seed(dst, 'commands/agenfk.md');

    pruneInstallDir(src, dst);

    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
  });

  it('reports what it removed instead of deleting silently', () => {
    seed(src, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const { removed } = pruneInstallDir(src, dst);

    expect(removed).toEqual(['commands/agenfk-release.md'.split('/').join(path.sep)]);
  });
});

describe('pruneInstallDir never copies', () => {
  it('prunes without calling fs.cpSync, which the cp -r runtimes do not have', () => {
    // The legacy branch in bin/agenfk.js exists only where fs.cpSync is absent,
    // and the tar-based upgrade paths have no source tree to copy from at all.
    seed(src, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const real = fs.cpSync;
    // @ts-expect-error — simulating a runtime without fs.cpSync
    delete fs.cpSync;
    try {
      const { removed } = pruneInstallDir(src, dst);
      expect(removed).toEqual(['commands/agenfk-release.md'.split('/').join(path.sep)]);
    } finally {
      fs.cpSync = real;
    }
    expect(existsSync(path.join(dst, 'commands/agenfk-release.md'))).toBe(false);
  });

});

describe('pruneInstallDir refuses to destroy data', () => {
  it('keeps a case-renamed file when folding is on, on ANY filesystem', () => {
    // The volume-probing test below cannot see this guard on CI: ubuntu is
    // case-sensitive, where folding is a no-op, so deleting isCaseInsensitive
    // entirely would be behaviourally identical there and stay green. Forcing
    // the decision is the only way the property is checked on Linux.
    seed(src, 'commands/agenfk.md', 'new\n');
    seed(dst, 'commands/AgenFK.md', 'old\n');

    const { removed } = pruneInstallDir(src, dst, { foldCase: true });

    expect(removed).toEqual([]);
    expect(existsSync(path.join(dst, 'commands/AgenFK.md'))).toBe(true);
  });

  it('deletes a case-renamed file when folding is off, on ANY filesystem', () => {
    // The other half: with folding off the two really are different files and
    // pruning the unshipped one is correct. Pinning both directions means the
    // fold decision itself is observable, not just its default.
    seed(src, 'commands/agenfk.md', 'new\n');
    seed(dst, 'commands/AgenFK.md', 'old\n');

    const { removed } = pruneInstallDir(src, dst, { foldCase: false });

    expect(removed).toEqual([path.join('commands', 'AgenFK.md')]);
    expect(existsSync(path.join(dst, 'commands/AgenFK.md'))).toBe(false);
  });

  it('keeps a file whose only difference is letter case, where the volume folds case', () => {
    // On macOS/NTFS, fs.cpSync writes agenfk.md into the EXISTING AgenFK.md
    // entry and keeps the old spelling, so exact-case matching reads the
    // surviving file as unshipped and deletes it — worse than not pruning.
    // On a case-SENSITIVE volume the two really are different files and
    // deleting the unshipped one is correct, so the expectation must follow
    // the volume, not the developer's laptop. CI runs ubuntu-latest.
    seed(src, 'commands/agenfk.md', 'new\n');
    seed(dst, 'commands/AgenFK.md', 'old\n');
    // Probe this exact volume the same way the implementation does.
    const probe = path.join(dst, '.case-probe');
    writeFileSync(probe, '');
    const foldsCase = existsSync(path.join(dst, '.CASE-PROBE'));
    rmSync(probe, { force: true });

    const { removed } = pruneInstallDir(src, dst);

    const survivors = fs.readdirSync(path.join(dst, 'commands'));
    if (foldsCase) {
      expect(removed).toEqual([]);
      expect(survivors).toHaveLength(1);
      expect(survivors[0].toLowerCase()).toBe('agenfk.md');
    } else {
      expect(removed).toEqual([path.join('commands', 'AgenFK.md')]);
      expect(survivors).toHaveLength(0);
    }
  });

  it('will not prune through a symlinked dir, which would delete outside the install dir', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'agenfk-sync-outside-'));
    try {
      seed(src, 'commands/agenfk.md');
      seed(outside, 'precious/notes.md', 'do not delete\n');
      symlinkSync(outside, path.join(dst, 'commands'));

      const { removed, failed } = pruneInstallDir(src, dst);

      expect(existsSync(path.join(outside, 'precious', 'notes.md'))).toBe(true);
      expect(removed).toEqual([]);
      expect(failed.map((f: { path: string }) => f.path)).toContain('commands');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a file it could not remove instead of reporting a clean upgrade', () => {
    seed(src, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const real = fs.rmSync;
    // @ts-expect-error — simulate EPERM on a locked-down install
    fs.rmSync = (p: string, o: unknown) => {
      if (String(p).endsWith('agenfk-release.md')) throw new Error('EPERM: operation not permitted');
      return real(p as never, o as never);
    };
    let result;
    try {
      result = pruneInstallDir(src, dst);
    } finally {
      fs.rmSync = real;
    }

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe(path.join('commands', 'agenfk-release.md'));
    expect(result.failed[0].reason).toMatch(/EPERM/);
  });
});

describe('pruneInstallDirAgainstManifest parses the archive listing', () => {
  // This function is the authority on three of the five upgrade routes, so a
  // listing shape it silently fails to understand makes the prune a no-op with
  // the suite green.
  it('prunes what the listing omits and keeps what it carries', () => {
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const { removed } = pruneInstallDirAgainstManifest(dst, ['commands/agenfk.md']);

    expect(removed).toEqual([path.join('commands', 'agenfk-release.md')]);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
  });

  it("tolerates GNU tar's ./ prefix", () => {
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const { removed } = pruneInstallDirAgainstManifest(dst, ['./commands/agenfk.md']);

    expect(removed).toEqual([path.join('commands', 'agenfk-release.md')]);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
  });

  it('ignores bare directory entries, which carry no file information', () => {
    seed(dst, 'commands/agenfk.md');

    // A listing of ONLY directory entries says nothing about files, so it must
    // not be read as "every file here is stale".
    const { removed } = pruneInstallDirAgainstManifest(dst, ['commands/', './commands/']);

    expect(removed).toEqual([]);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
  });

  it('prunes NOTHING when the archive uses an unexpected top-level prefix', () => {
    // e.g. `agenfk-1.1.19/commands/...`. Every bucket then comes back empty and
    // the prune must no-op rather than conclude the whole install is stale.
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const { removed } = pruneInstallDirAgainstManifest(dst, [
      'agenfk-1.1.19/commands/agenfk.md',
      'agenfk-1.1.19/commands/agenfk-plan.md',
    ]);

    expect(removed).toEqual([]);
    expect(existsSync(path.join(dst, 'commands/agenfk-release.md'))).toBe(true);
  });

  it('tolerates a trailing carriage return on every line', () => {
    // A tar listing read on Windows or through a CRLF pipe. Before the trim,
    // the bucket was non-empty (of "\r"-suffixed names) so the empty-source
    // guard passed, and every REAL file was judged unshipped: measured as both
    // commands deleted and the directory left empty. Worst over-deletion the
    // module had.
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-plan.md');
    seed(dst, 'commands/agenfk-release.md');

    const { removed } = pruneInstallDirAgainstManifest(dst, [
      'commands/agenfk.md\r',
      'commands/agenfk-plan.md\r',
    ]);

    expect(removed).toEqual([path.join('commands', 'agenfk-release.md')]);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
    expect(existsSync(path.join(dst, 'commands/agenfk-plan.md'))).toBe(true);
  });

  it('normalises backslash separators', () => {
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk-release.md');

    const { removed } = pruneInstallDirAgainstManifest(dst, ['commands\\agenfk.md']);

    expect(removed).toEqual([path.join('commands', 'agenfk-release.md')]);
    expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
  });
});

describe('isCaseInsensitive probes the volume', () => {
  // Tested directly, because on a case-sensitive CI runner the probe's RESULT
  // is indistinguishable from its absence: folding is a no-op there, so
  // hardcoding `false` would leave the rest of the suite green.
  it('agrees with what the filesystem actually does', () => {
    const probe = path.join(dst, '.case-probe');
    writeFileSync(probe, '');
    const volumeFolds = existsSync(path.join(dst, '.CASE-PROBE'));
    rmSync(probe, { force: true });

    expect(isCaseInsensitive(dst)).toBe(volumeFolds);
  });

  it('assumes folding when it cannot probe, because that deletes strictly less', () => {
    // A read-only or EACCES install dir. Exact matching is the OVER-deleting
    // mode, so an unprobeable volume must fall back to the conservative side.
    const real = fs.writeFileSync;
    // @ts-expect-error — simulate an unwritable directory
    fs.writeFileSync = () => { throw new Error('EACCES: permission denied'); };
    try {
      expect(isCaseInsensitive(dst)).toBe(true);
    } finally {
      fs.writeFileSync = real;
    }
  });

  it('leaves no probe file behind', () => {
    isCaseInsensitive(dst);
    expect(fs.readdirSync(dst).filter((n: string) => n.includes('case-probe'))).toEqual([]);
  });
});

describe('pruneInstallDir keeps directories the archive ships intentionally empty', () => {
  it('does not delete an empty directory that lost no files this pass', () => {
    // The manifest parser drops directory entries, so an intentionally-empty
    // shipped dir has no shipped CHILD to keep it alive. Removing every empty
    // dir under the pruned tree (what this used to do, unconditionally) deleted
    // it on every upgrade.
    seed(src, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/dead.md');
    mkdirSync(path.join(dst, 'commands/placeholder'), { recursive: true });

    pruneInstallDir(src, dst);

    expect(existsSync(path.join(dst, 'commands/dead.md'))).toBe(false);
    expect(existsSync(path.join(dst, 'commands/placeholder'))).toBe(true);
  });

  it('still removes a directory this pass emptied', () => {
    seed(src, 'skills/kept/SKILL.md');
    seed(dst, 'skills/kept/SKILL.md');
    seed(dst, 'skills/gone/SKILL.md');

    pruneInstallDir(src, dst);

    expect(existsSync(path.join(dst, 'skills/gone'))).toBe(false);
  });
});

describe('pruneInstallDir fails closed on an unreadable source tree', () => {
  // Reading a PARTIAL listing as "not shipped" deletes live files. An unreadable
  // source subtree must skip the prune, not shrink the shipped set.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('does not prune a dir whose source listing cannot be read', () => {
    seed(src, 'commands/agenfk.md');
    seed(src, 'commands/locked/hidden.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/dead.md');
    const locked = path.join(src, 'commands', 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      pruneInstallDir(src, dst);
      expect(existsSync(path.join(dst, 'commands/dead.md'))).toBe(true);
      expect(existsSync(path.join(dst, 'commands/agenfk.md'))).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe('pruneInstallDir does not abort an upgrade over an unreadable install dir', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('still prunes what it can see when a destination subdir cannot be read', () => {
    // The SOURCE listing must be strict (a partial one deletes live files), but
    // the DESTINATION walk must stay lenient: throwing there would abort the
    // user's upgrade over one unreadable subdirectory, and a partial walk only
    // means fewer files are considered — under-delete, the safe direction.
    seed(src, 'commands/agenfk.md');
    seed(dst, 'commands/agenfk.md');
    seed(dst, 'commands/dead.md');
    seed(dst, 'commands/locked/x.md');
    const locked = path.join(dst, 'commands', 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      expect(() => pruneInstallDir(src, dst)).not.toThrow();
      expect(existsSync(path.join(dst, 'commands', 'dead.md'))).toBe(false);
      expect(existsSync(path.join(dst, 'commands', 'agenfk.md'))).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});
