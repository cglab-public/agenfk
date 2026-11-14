/**
 * @file GitHub #208 — `agenfk upgrade` extracts with the tar it meets.
 *
 * The CLI extracted the release with
 * `tar --exclude='._*' --exclude='.DS_Store' -xzf "C:\..." -C "C:\..."` on
 * every OS. Under Git Bash that is GNU tar, which reads `C:` as a remote host
 * ("Cannot connect to C: resolve failed") and unescapes backslashes in -C; and
 * under cmd.exe the single quotes stay in the pattern, so the AppleDouble
 * exclusion matched nothing. Same rule as bin/tar-flags.mjs: GNU tar on Windows
 * gets --force-local and C:/ paths, bsdtar native paths and no flag, POSIX the
 * command it always had, all with double-quoted excludes.
 *
 * packages/cli is compiled by tsc to CommonJS and ships its dist/ alone, so it
 * carries the rule as src/tarFlags.ts rather than loading the root's ESM
 * module at run time; the parity block below keeps the two from drifting.
 */
import { describe, it, expect } from 'vitest';
import { isGnuTar, needsForceLocal, tarPathFor, upgradeExtractCommand } from '../tarFlags';
import * as shared from '../../../../bin/tar-flags.mjs';

const GNU = 'tar (GNU tar) 1.35\n';
const BSD = 'bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley\n';
const MAC = 'bsdtar 3.5.3 - libarchive 3.7.4 zlib/1.2.12\n';
const EXCLUDES = '--exclude="._*" --exclude=".DS_Store"';

describe('upgradeExtractCommand', () => {
  const ARCHIVE = 'C:\\Users\\u\\AppData\\Local\\Temp\\agenfk-upgrade-1\\agenfk-dist.tar.gz';
  const ROOT = 'C:\\Users\\u\\.agenfk-system';

  it('GNU tar on Windows: --force-local and C:/ paths', () => {
    expect(upgradeExtractCommand('win32', GNU, ARCHIVE, ROOT)).toBe(
      `tar --force-local ${EXCLUDES} -xzf "C:/Users/u/AppData/Local/Temp/agenfk-upgrade-1/agenfk-dist.tar.gz" -C "C:/Users/u/.agenfk-system"`);
  });

  it('bsdtar on Windows: native paths, no --force-local (it rejects the flag)', () => {
    expect(upgradeExtractCommand('win32', BSD, ARCHIVE, ROOT)).toBe(`tar ${EXCLUDES} -xzf "${ARCHIVE}" -C "${ROOT}"`);
  });

  it('off Windows: the command as before, with the excludes double-quoted', () => {
    expect(upgradeExtractCommand('linux', GNU, '/tmp/agenfk-upgrade-1/agenfk-dist.tar.gz', '/home/u/.agenfk-system'))
      .toBe(`tar ${EXCLUDES} -xzf "/tmp/agenfk-upgrade-1/agenfk-dist.tar.gz" -C "/home/u/.agenfk-system"`);
    expect(upgradeExtractCommand('darwin', MAC, '/tmp/a.tar.gz', '/Users/u/.agenfk-system'))
      .toBe(`tar ${EXCLUDES} -xzf "/tmp/a.tar.gz" -C "/Users/u/.agenfk-system"`);
  });
});

describe('the CLI copy of the rule agrees with bin/tar-flags.mjs', () => {
  const versions = [GNU, BSD, MAC, '', undefined];
  const platforms: NodeJS.Platform[] = ['win32', 'linux', 'darwin'];
  const paths = ['C:\\Users\\u\\x.tar.gz', '/home/u/x.tar.gz', 'C:\\Temp\\tf-x'];

  it('on every platform, tar and path', () => {
    for (const v of versions) {
      expect(isGnuTar(v)).toBe(shared.isGnuTar(v));
      for (const platform of platforms) {
        expect(needsForceLocal(platform, v)).toBe(shared.needsForceLocal(platform, v));
        for (const p of paths) expect(tarPathFor(p, platform, v)).toBe(shared.tarPathFor(p, platform, v));
      }
    }
  });
});
