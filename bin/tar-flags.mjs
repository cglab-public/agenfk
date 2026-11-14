import { execSync } from 'child_process';

/**
 * Which tar the installers are about to run, and what it needs on Windows
 * (GitHub #208).
 *
 * The installers passed `--force-local` on every win32 run, on the belief that
 * BSD tar reads `C:` as a remote hostname. It is the other way round: GNU tar
 * (Git Bash's /usr/bin/tar) does, and needs the flag; the tar Windows ships -
 * System32\tar.exe, bsdtar, the one cmd and PowerShell find - takes `C:\...`
 * as it is and REJECTS the flag ("Option --force-local is not supported").
 * So `npx github:cglab-public/agenfk` run from cmd or PowerShell could never
 * extract the release it downloaded.
 *
 * The paths follow the tar too. GNU tar unescapes backslashes in -C, so
 * `-C "C:\...\Temp\tf-x"` names a directory with a TAB in it. It was given an
 * MSYS2 `/c/...` path only when the installer ran under Git Bash (MSYSTEM),
 * never when cmd or PowerShell found GNU tar first. GNU tar on Windows now gets
 * `C:/...` from any shell: a drive-letter path with forward slashes, which it
 * takes with --force-local and which, unlike `/c/...`, does not depend on the
 * MSYS2 cygdrive mount. bsdtar keeps native paths (it would read `/c/Users` as
 * \c\Users on the current drive).
 */

/** Whether `tar --version` output is GNU tar's. */
export function isGnuTar(versionText) {
  return /\bGNU tar\b/.test(String(versionText || ''));
}

/** `--force-local` only where it is both needed and understood: GNU tar on Windows. */
export function needsForceLocal(platform, versionText) {
  return platform === 'win32' && isGnuTar(versionText);
}

let probed;
/**
 * The `tar --version` of the tar on PATH, asked once. Off Windows nothing
 * depends on it, so nothing is spawned there.
 */
export function tarVersionText() {
  if (process.platform !== 'win32') return '';
  if (probed === undefined) {
    try {
      probed = execSync('tar --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      probed = '';
    }
  }
  return probed;
}

/** `--force-local ` (with its space) for the tar on PATH, or nothing. */
export function forceLocalFlag() {
  return needsForceLocal(process.platform, tarVersionText()) ? '--force-local ' : '';
}

/** A path as the tar takes it: forward slashes for GNU tar on Windows, otherwise as given. */
export function tarPathFor(p, platform, versionText) {
  return platform === 'win32' && isGnuTar(versionText) ? String(p).replace(/\\/g, '/') : p;
}

/** A path as the tar on PATH takes it. */
export function tarPath(p) {
  return tarPathFor(p, process.platform, tarVersionText());
}
