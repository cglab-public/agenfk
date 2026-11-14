import { execSync } from 'child_process';

/**
 * The tar command `agenfk upgrade` runs, for the tar this machine has
 * (GitHub #208). The rule of bin/tar-flags.mjs, carried here because this
 * package is compiled by tsc to CommonJS and its dist/ cannot load that ESM
 * module synchronously on every Node it supports; a spec keeps the two equal.
 *
 * The bsdtar Windows ships (System32\tar.exe, what cmd and PowerShell find)
 * takes `C:\...` as it is and rejects --force-local. GNU tar (Git Bash's)
 * reads `C:` as a remote host, so it needs --force-local, and it unescapes
 * backslashes in -C, so it gets `C:/...`. Off Windows nothing changes.
 */
export function isGnuTar(versionText: string | undefined): boolean {
  return /\bGNU tar\b/.test(String(versionText || ''));
}

export function needsForceLocal(platform: NodeJS.Platform, versionText: string | undefined): boolean {
  return platform === 'win32' && isGnuTar(versionText);
}

export function tarPathFor(p: string, platform: NodeJS.Platform, versionText: string | undefined): string {
  return needsForceLocal(platform, versionText) ? p.replace(/\\/g, '/') : p;
}

/**
 * Extract the release over the install root, keeping macOS metadata out.
 * Double quotes: cmd.exe keeps single quotes as part of the pattern.
 */
export function upgradeExtractCommand(platform: NodeJS.Platform, versionText: string | undefined, archive: string, dir: string): string {
  const flag = needsForceLocal(platform, versionText) ? '--force-local ' : '';
  const p = (x: string) => tarPathFor(x, platform, versionText);
  return `tar ${flag}--exclude="._*" --exclude=".DS_Store" -xzf "${p(archive)}" -C "${p(dir)}"`;
}

let probed: string | undefined;
/** `tar --version` of the tar on PATH, asked once and only on Windows. */
export function tarVersionText(): string {
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
