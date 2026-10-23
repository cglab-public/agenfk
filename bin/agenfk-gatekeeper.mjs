#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

/**
 * Resolve the AgEnFK API base URL.
 *
 * The API server binds to whatever port is free (bumping off 3000 when it is
 * busy) and records the ACTUAL port in ~/.agenfk/server-port. This hook is a
 * standalone script installed under ~/.agenfk/bin (no access to @agenfk/telemetry),
 * so it reads that file directly. If it hardcoded :3000 it would reach nothing
 * whenever the server bumped ports, fail open, and silently stop enforcing.
 *
 * Precedence mirrors telemetry's getApiUrl(): explicit AGENFK_API_URL wins, then
 * the server-written port file (the actual bound port), then the AGENFK_PORT/PORT
 * env hints (the requested port), then the default.
 */
export function resolveApiUrl(env = process.env, homeDir = os.homedir()) {
  if (env.AGENFK_API_URL) return env.AGENFK_API_URL;
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.agenfk', 'server-port'), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`;
  } catch { /* file not written yet — fall through */ }
  const envPort = env.AGENFK_PORT || env.PORT;
  if (envPort) {
    const n = Number.parseInt(String(envPort), 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`;
  }
  return 'http://127.0.0.1:3000';
}

const API_URL = resolveApiUrl();

// Read and parse stdin robustly to understand the tool context
async function getToolIntent() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(null), 500); // Wait up to 500ms
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => data += chunk);
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            try {
                if (!data.trim()) {
                    resolve(null);
                    return;
                }
                const json = JSON.parse(data);
                resolve(json && typeof json === 'object' ? json : null);
            } catch {
                resolve(null);
            }
        });
        // If stdin is closed but no data was received
        process.stdin.on('close', () => {
            clearTimeout(timeout);
            resolve(null);
        });
    });
}

function normalizePath(p) {
    if (!p) return p;
    // Handle MinGW/MSYS2 paths: /c/Users -> C:/Users
    if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) {
        return p[1].toUpperCase() + ':' + p.slice(2);
    }
    return p;
}

// A project's .agenfk holds project.json (shared settings) or local.json (this
// machine's id, CGLAB-625) - either marks it, since project.json is optional.
function marksProject(dir) {
    return fs.existsSync(path.join(dir, '.agenfk', 'project.json')) || fs.existsSync(path.join(dir, '.agenfk', 'local.json'));
}

/*
 * Which project a path belongs to — the same answer as @agenfk/core's
 * resolveProjectIdentity, which the CLI's `agenfk gatekeeper` uses. This hook is
 * copied to ~/.agenfk/bin and cannot import core, so the rule is restated here;
 * gatekeeper-hook-project-scope.test.ts checks the two agree.
 */

/** The id a local.json (or a legacy project.json) names, or null. */
function readProjectIdFile(file) {
    try {
        const st = fs.statSync(file);
        // A FIFO would block this sync read for ever; the files are tiny.
        if (!st.isFile() || st.size > 64 * 1024) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const id = parsed.projectId;
        return typeof id === 'string' && id.trim() ? id.trim() : null;
    } catch {
        return null;
    }
}

/** The nearest dir at or above `startDir` that marks a project, and the id it names. */
function nearestProject(startDir) {
    for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
        if (marksProject(dir)) {
            const projectId = readProjectIdFile(path.join(dir, '.agenfk', 'local.json'))
                ?? readProjectIdFile(path.join(dir, '.agenfk', 'project.json'));
            return { root: dir, projectId };
        }
        if (path.dirname(dir) === dir) return null;
    }
}

/** Inside a linked worktree: its top and the main checkout, read from the `.git` file. */
function linkedWorktreeOf(startDir) {
    for (let cur = path.resolve(startDir); ; cur = path.dirname(cur)) {
        const dotGit = path.join(cur, '.git');
        let st = null;
        try { st = fs.lstatSync(dotGit); } catch { /* none here */ }
        if (st && !st.isFile()) return null; // a main checkout's .git directory
        if (st?.isFile()) {
            let text = null;
            try { text = st.size <= 4096 ? fs.readFileSync(dotGit, 'utf8') : null; } catch { /* unreadable */ }
            const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
            if (!m) return null;
            const gitDir = path.resolve(cur, m[1]);
            const common = path.dirname(path.dirname(gitDir));
            if (path.basename(path.dirname(gitDir)) !== 'worktrees' || path.basename(common) !== '.git') return null;
            let config = null;
            try { config = fs.readFileSync(path.join(common, 'config'), 'utf8'); } catch { /* none */ }
            if (config && /^\s*bare\s*=\s*true\s*$/mi.test(config)) return null;
            return { top: cur, main: path.dirname(common) };
        }
        if (path.dirname(cur) === cur) return null;
    }
}

const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);

/**
 * The project the edited file belongs to: null outside any project, else
 * { root, projectId } — projectId null for a project this machine has not linked.
 * A linked worktree carries no local.json (it is git-ignored), so its id comes
 * from the main checkout's matching directory, as in core.
 */
export function findAgenFKProject(filePath) {
    if (!filePath) return null;
    const normalized = normalizePath(filePath);
    const startDir = path.dirname(path.isAbsolute(normalized) ? normalized : path.resolve(normalized));
    const found = nearestProject(startDir);
    const wt = linkedWorktreeOf(startDir);
    const ownMarker = !!found && !!wt && within(found.root, wt.top);
    if (!wt || (ownMarker && found.projectId)) return found;
    const there = nearestProject(path.join(wt.main, path.relative(wt.top, ownMarker ? found.root : startDir)));
    if (there?.projectId && within(there.root, wt.main)) {
        return { root: path.join(wt.top, path.relative(wt.main, there.root)), projectId: there.projectId };
    }
    return found;
}

// Statuses that are never considered "active coding" regardless of flow name.
const INACTIVE_STATUSES = new Set(['TODO', 'DONE', 'BLOCKED', 'PAUSED', 'IDEAS', 'ARCHIVED', 'TRASHED']);

// Only the edited file's project counts. Asking for every project's items let an
// active task in repo A authorize edits in repo B — the hooks are global, so one
// open task anywhere switched enforcement off everywhere — while the CLI's
// `agenfk gatekeeper` already scoped to the current project and refused the same
// edit. With no projectId (a project this machine has not linked) all items
// count, as before.
async function checkInProgress(projectId) {
    return new Promise((resolve) => {
        // No status filter, so custom coding-step names (e.g. 'create_unit_tests'
        // in a TDD flow) are recognised as active.
        const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
        const req = http.get(`${API_URL}/items${query}`, { timeout: 2000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve(true); // Graceful skip on API issues
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const items = JSON.parse(data);
                    // Filtered here as well: the hook is copied to ~/.agenfk/bin and
                    // may outlive the server it was installed with, and a server
                    // that ignores ?projectId= must not reopen the leak.
                    const hasActive = Array.isArray(items) && items.some(i =>
                        (!projectId || i.projectId === projectId) &&
                        !INACTIVE_STATUSES.has((i.status ?? '').toUpperCase())
                    );
                    resolve(hasActive);
                } catch (e) {
                    resolve(true); // Graceful skip on parse error
                }
            });
        });

        req.on('error', () => resolve(true)); // Graceful skip on connection error
        req.on('timeout', () => {
            req.destroy();
            resolve(true);
        });
    });
}

async function main() {
    const toolIntent = await getToolIntent();

    // Extract file path from tool input (Edit/Write use file_path, NotebookEdit uses notebook_path)
    const filePath = toolIntent?.tool_input?.file_path || toolIntent?.tool_input?.notebook_path || null;

    // Only enforce workflow for files inside an AgenFK-managed project directory
    const project = findAgenFKProject(filePath);
    if (!project) {
        process.exit(0);
    }

    // Allow release commands to bypass the gatekeeper via a short-lived flag file
    const skipFlagPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.agenfk', 'skip-gatekeeper');
    if (fs.existsSync(skipFlagPath)) {
        const ageMs = Date.now() - fs.statSync(skipFlagPath).mtimeMs;
        if (ageMs < 5 * 60 * 1000) {
            process.exit(0); // Flag is fresh — release command in progress, allow
        }
        fs.unlinkSync(skipFlagPath); // Stale flag — clean up and enforce normally
    }

    const hasInProgress = await checkInProgress(project.projectId);

    if (!hasInProgress) {
        const toolName = toolIntent?.tool_name || toolIntent?.tool || 'unknown tool';
        const reason = `AgenFK WORKFLOW VIOLATION: No task is actively being worked on in this file's project while attempting to use ${toolName}.\n\nBefore modifying files you must have a task OF THIS PROJECT in an active coding step (e.g. IN_PROGRESS, create_unit_tests, or your flow's first working step) — an active task in another project does not count.\n\nFrom inside the project's directory (so the task is filed in this project):\n  1. Create a task:  agenfk create task "<title>"\n  2. Start it:       agenfk verify <id> --evidence "<your plan>"  (advances from TODO to the coding step)\n\nThen retry your change.`;

        process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: reason
        }));
    }

    process.exit(0);
}

// ESM entry detection: only run when executed directly, not when imported (unit
// tests import resolveApiUrl without triggering the enforcement logic).
const isMain = (() => {
    try {
        if (!process.argv[1]) return false;
        // Compare real filesystem paths, not `new URL(import.meta.url).pathname`:
        // on Windows the URL pathname is `/C:/...` while argv[1] is `C:\...`, so
        // a string compare never matched and the hook silently never ran.
        const self = fs.realpathSync(fileURLToPath(import.meta.url));
        const entry = fs.realpathSync(path.resolve(process.argv[1]));
        return process.platform === 'win32'
            ? self.toLowerCase() === entry.toLowerCase()
            : self === entry;
    } catch { return false; }
})();
if (isMain) {
    main().catch(() => process.exit(0));
}
