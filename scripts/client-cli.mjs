// Launching the AI client CLIs (claude, codex, gemini, cursor, opencode, pi)
// from the installer and uninstaller (BUG ad57c267).
//
// On Windows a client is either a native .exe (Claude Code's own installer) or
// an npm .cmd shim. Node >= 18.20.2 / 20.12.2 - every 22.x agenfk supports -
// refuses to spawn a .cmd or .bat without a shell (CVE-2024-27980): spawnSync
// answers EINVAL. Forcing a '.cmd' suffix was therefore wrong twice over: EINVAL
// for the shim, ENOENT for the .exe.
//
// So the client is found on PATH here - only PATH, never the current
// directory, and only as .exe/.cmd/.bat (cmd.exe would also look in the cwd and
// try .js/.vbs, running a repo's stray claude.js instead of Claude Code). An
// .exe is spawned directly; a .cmd/.bat goes through cmd.exe with its absolute
// path.
//
// Mirrored in packages/cli/src/runTool.ts for the CLI; keep the two in step.
import { spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';

// Arguments made only of these reach cmd.exe as they are; anything else is
// double-quoted, which keeps spaces and & | < > ^ ( ) , = literal. Limits of
// the cmd.exe route (shims only - an .exe never sees cmd.exe): a %NAME% inside
// quotes is still expanded when NAME is set, and '!' is eaten when delayed
// expansion is on in the registry. The paths the installer passes (profile,
// db, bin) do not carry either in practice.
const WIN_BARE_ARG = /^[A-Za-z0-9_\-.:/\\@+]+$/;
const WIN_LAUNCHABLE = ['.exe', '.cmd', '.bat'];

function quoteWindowsArg(name, arg) {
    const s = String(arg);
    if (s.includes('"')) {
        throw new Error(`Cannot pass an argument holding a double quote to ${name} through cmd.exe: ${s}`);
    }
    if (WIN_BARE_ARG.test(s)) return s;
    // Backslashes before the closing quote are doubled, or the program's argv
    // parser reads `\"` as an escaped quote and the argument runs on.
    return `"${s.replace(/(\\+)$/, '$1$1')}"`;
}

/** The command line cmd.exe is handed to run `file args...`; a '"' in an argument is refused. */
export function windowsCommandLine(file, args) {
    return [file, ...args].map((a) => quoteWindowsArg(file, a)).join(' ');
}

/**
 * Anything but a directory. A Windows Store app alias is a reparse point that
 * stat either fails on or reports as a symlink (not a file) - both still launch.
 */
function isLaunchable(file) {
    try {
        return !statSync(file).isDirectory();
    } catch {
        return true;
    }
}

/**
 * The client's launchable file on PATH (.exe/.cmd/.bat, in PATHEXT order), or
 * null. The current directory is not searched.
 */
export function resolveWindowsTool(name, env = process.env) {
    const key = (k) => Object.keys(env).find((e) => e.toUpperCase() === k);
    const dirs = String(env[key('PATH')] ?? '').split(';').map((d) => d.replace(/^"|"$/g, ''))
      // A relative entry ('.', node_modules\.bin) would be the cwd lookup again.
      .filter((d) => d && path.isAbsolute(d));
    const exts = String(env[key('PATHEXT')] ?? '.EXE;.CMD;.BAT').split(';')
        .map((e) => e.toLowerCase()).filter((e) => WIN_LAUNCHABLE.includes(e));
    if (exts.length === 0) exts.push(...WIN_LAUNCHABLE); // PATHEXT set but empty: cmd.exe's defaults
    for (const dir of dirs) {
        for (const ext of exts) {
            const file = path.join(dir, name + ext);
            try {
                if (existsSync(file) && isLaunchable(file)) return file;
            } catch { /* unreadable PATH entry - keep looking */ }
        }
    }
    return null;
}

/**
 * spawnSync for a client CLI by bare name, on every platform. A client that is
 * not installed answers status null with an ENOENT error, as spawnSync does.
 * On Windows a timeout or kill aimed at a .cmd/.bat client reaches cmd.exe,
 * not the program the shim started.
 */
export function runTool(name, args, opts = {}) {
    if (process.platform !== 'win32') return spawnSync(name, args, { windowsHide: true, ...opts });
    const file = resolveWindowsTool(name, opts.env ?? process.env);
    if (!file) {
        const error = Object.assign(new Error(`spawnSync ${name} ENOENT`), { code: 'ENOENT', syscall: `spawnSync ${name}`, path: name });
        return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error };
    }
    if (file.toLowerCase().endsWith('.exe')) return spawnSync(file, args, { windowsHide: true, ...opts });
    return spawnSync(windowsCommandLine(file, args), { windowsHide: true, ...opts, shell: true });
}
