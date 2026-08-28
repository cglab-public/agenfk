import { execSync } from 'child_process';

/**
 * macOS metadata that must never enter a release archive.
 *
 * On macOS, bsdtar writes an AppleDouble `._<name>` companion entry for every
 * file carrying an extended attribute, unless COPYFILE_DISABLE is set. Because
 * this checkout's files carry `com.apple.provenance`, every release cut from a
 * Mac shipped roughly one `._*` entry per real file (436 of 872 members in
 * v1.1.16-beta.3). Consumers then saw them as real files: the installer copied
 * them verbatim and the skills sync surfaced `._agenfk-*` as garbage skills in
 * every agent session (CGLAB-94 / issue #163).
 *
 * Belt and braces, because the two mechanisms cover different cases:
 *  - COPYFILE_DISABLE=1 stops bsdtar SYNTHESISING AppleDouble entries from
 *    xattrs that exist only as metadata.
 *  - --exclude drops `._*` / .DS_Store files that are physically on disk (e.g.
 *    left behind by extracting an older, polluted tarball) on every platform.
 */
export const EXCLUDED_PATTERNS = ['._*', '.DS_Store'];

/**
 * Create a .tar.gz release archive with macOS metadata suppressed.
 *
 * @param {object} opts
 * @param {string} opts.cwd      directory to archive from
 * @param {string} opts.outFile  archive filename, relative to cwd
 * @param {string[]} opts.include paths to include, relative to cwd
 */
export function createTarball({ cwd, outFile, include }) {
    const excludes = EXCLUDED_PATTERNS.map((p) => `--exclude='${p}'`).join(' ');
    // --no-xattrs drops the LIBARCHIVE.xattr.* / SCHILY.xattr.* PAX headers that
    // bsdtar attaches for `com.apple.provenance`. They are inert payload here,
    // and GNU tar prints "Ignoring unknown extended header keyword" for every
    // one of them on extraction — one warning per file, on every Linux install.
    // Supported by both bsdtar (macOS) and GNU tar (CI).
    execSync(`tar --no-xattrs ${excludes} -czf ${outFile} ${include.join(' ')}`, {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
}
