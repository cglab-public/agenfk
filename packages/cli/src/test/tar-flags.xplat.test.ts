/**
 * @file GitHub #208 — `--force-local` only for the tar that needs it.
 *
 * bin/agenfk.js, bin/agenfk-hub.js and scripts/install.mjs passed
 * `--force-local` on every win32 run, believing BSD tar reads `C:` as a remote
 * hostname. It is GNU tar (Git Bash's) that does; the tar Windows ships
 * (System32\tar.exe, bsdtar - what cmd and PowerShell find) takes `C:\...` as
 * it is and rejects the flag outright, so the release was never extracted when
 * the installer ran from cmd or PowerShell. The flag now follows the tar.
 *
 * And the AppleDouble excludes were single-quoted, which cmd.exe keeps as part
 * of the pattern: on Windows `--exclude='._*'` excluded nothing.
 *
 * The paths follow the tar as well. GNU tar unescapes backslashes in -C, so
 * `-C "C:\...\Temp\tf-x"` named a directory with a TAB in it and the extract
 * failed; it was given an MSYS2 `/c/...` path only under Git Bash (MSYSTEM),
 * never when cmd or PowerShell found GNU tar first. GNU tar on Windows now gets
 * `C:/...` - a drive-letter path with forward slashes, which it takes from
 * any shell (with --force-local) and which, unlike `/c/...`, does not depend on
 * the MSYS2 cygdrive mount. bsdtar keeps native paths.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isGnuTar, needsForceLocal, forceLocalFlag, tarPathFor, tarPath } from '../../../../bin/tar-flags.mjs';

const GNU = 'tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.\n';
const BSD = 'bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley liblzma/5.8.1 bz2lib/1.0.8\n';
const MAC = 'bsdtar 3.5.3 - libarchive 3.7.4 zlib/1.2.12 liblzma/5.4.3 bz2lib/1.0.8\n';

describe('isGnuTar', () => {
  it('knows GNU tar by its --version line', () => {
    expect(isGnuTar(GNU)).toBe(true);
  });

  it('is false for bsdtar (Windows, macOS) and for no answer at all', () => {
    expect(isGnuTar(BSD)).toBe(false);
    expect(isGnuTar(MAC)).toBe(false);
    expect(isGnuTar('')).toBe(false);
    expect(isGnuTar(undefined)).toBe(false);
  });
});

describe('needsForceLocal', () => {
  it('is true for GNU tar on Windows, which reads C: as a remote host', () => {
    expect(needsForceLocal('win32', GNU)).toBe(true);
  });

  it('is false for the bsdtar Windows ships, which rejects the flag', () => {
    expect(needsForceLocal('win32', BSD)).toBe(false);
  });

  it('is false off Windows, whatever the tar: no drive letters there', () => {
    expect(needsForceLocal('linux', GNU)).toBe(false);
    expect(needsForceLocal('darwin', MAC)).toBe(false);
  });
});

describe('tarPathFor', () => {
  const ARCHIVE = 'C:\\Users\\u\\.agenfk-system\\agenfk-dist.tar.gz';
  const DIR = 'C:\\Users\\u\\AppData\\Local\\Temp\\tf-x';

  it('GNU tar on Windows: forward slashes, so no backslash is read as an escape', () => {
    expect(tarPathFor(ARCHIVE, 'win32', GNU)).toBe('C:/Users/u/.agenfk-system/agenfk-dist.tar.gz');
    expect(tarPathFor(DIR, 'win32', GNU)).toBe('C:/Users/u/AppData/Local/Temp/tf-x');
  });

  it('bsdtar on Windows: the native path, as it always was', () => {
    expect(tarPathFor(ARCHIVE, 'win32', BSD)).toBe(ARCHIVE);
    expect(tarPathFor(DIR, 'win32', '')).toBe(DIR);
  });

  it('off Windows: unchanged, whatever the tar', () => {
    expect(tarPathFor('/home/u/.agenfk-system/x.tar.gz', 'linux', GNU)).toBe('/home/u/.agenfk-system/x.tar.gz');
    expect(tarPathFor('/Users/u/a\\b', 'darwin', MAC)).toBe('/Users/u/a\\b');
  });
});

describe('on this machine', () => {
  let work = '';
  afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); work = ''; });

  /** A gzipped archive with one real file and one AppleDouble twin, built by the tar on PATH. */
  function archive(): string {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-tarflags-'));
    const stage = path.join(work, 'stage');
    fs.mkdirSync(path.join(stage, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'commands', 'agenfk.md'), 'x');
    fs.writeFileSync(path.join(stage, 'commands', '._agenfk.md'), 'appledouble');
    const tarball = path.join(work, 'dist.tar.gz');
    execSync(`tar ${forceLocalFlag()}-czf "${tarPath(tarball)}" -C "${tarPath(stage)}" commands`, { stdio: 'pipe', windowsHide: true });
    return tarball;
  }

  it('the tar on PATH accepts the flags and the absolute path the installers give it', () => {
    const tarball = archive();
    const listing = execSync(`tar ${forceLocalFlag()}-tzf "${tarPath(tarball)}"`, { encoding: 'utf8', windowsHide: true });
    expect(listing.split(/\r?\n/)).toContain('commands/agenfk.md');
  });

  it('extracts with -C into a directory whose name a backslash would turn into an escape', () => {
    // `...\tout`: under GNU tar a native path read `\t` as a TAB.
    const tarball = archive();
    const out = path.join(work, 'tout');
    fs.mkdirSync(out);
    execSync(`tar ${forceLocalFlag()}-xzf "${tarPath(tarball)}" -C "${tarPath(out)}"`, { stdio: 'pipe', windowsHide: true });
    expect(fs.existsSync(path.join(out, 'commands', 'agenfk.md'))).toBe(true);
  });

  it('the double-quoted excludes keep AppleDouble files out, through this OS\'s shell', () => {
    const tarball = archive();
    const out = path.join(work, 'out');
    fs.mkdirSync(out);
    execSync(`tar ${forceLocalFlag()}--exclude="._*" --exclude=".DS_Store" -xzf "${tarPath(tarball)}" -C "${tarPath(out)}"`, { stdio: 'pipe', windowsHide: true });
    expect(fs.readdirSync(path.join(out, 'commands'))).toEqual(['agenfk.md']);
  });

  it('the flag matches what the tar on PATH says it is', () => {
    const version = execSync('tar --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    expect(forceLocalFlag()).toBe(process.platform === 'win32' && isGnuTar(version) ? '--force-local ' : '');
  });
});
