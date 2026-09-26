#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// Walk up from filePath looking for .agenfk/project.json
function isInsideAgenFKProject(filePath) {
    if (!filePath) return false;
    const normalized = normalizePath(filePath);
    let dir = path.isAbsolute(normalized) ? path.dirname(normalized) : path.dirname(path.resolve(normalized));
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.agenfk', 'project.json'))) return true;
        dir = path.dirname(dir);
    }
    return false;
}

// Statuses that are never considered "active coding" regardless of flow name.
const INACTIVE_STATUSES = new Set(['TODO', 'DONE', 'BLOCKED', 'PAUSED', 'IDEAS', 'ARCHIVED', 'TRASHED']);

// Statuses where a card has stopped owning the files it claimed. NOT the set
// above: a PAUSED card is not working, but its half-edited files are still in
// the shared tree and handing them to somebody else is the exact race claims
// exist to prevent. Kept in step with RELEASED_STATUSES in
// packages/core/src/claimGate.ts - a test pins that the two agree.
const RELEASED_STATUSES = new Set(['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS']);

/*
 * A deliberately duplicated copy of claimsCollide from packages/core.
 *
 * This file is installed standalone into each client's config directory and
 * cannot resolve @agenfk/core, so the choice is a copy or no check at all.
 * The copy is kept minimal and a test asserts it agrees with the original on
 * the cases that matter; a second implementation that DRIFTS is worse than
 * either, which is why the agreement is pinned rather than assumed.
 */
function normaliseClaim(claim) {
    return String(claim).replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}
function claimsCollide(a, b) {
    const x = normaliseClaim(a), y = normaliseClaim(b);
    if (x === y) return true;
    const contains = (outer, inner) => outer !== '' && inner.startsWith(outer + '/');
    return contains(x, y) || contains(y, x);
}

/** The path of `filePath` relative to the project root that owns it, or null. */
function repoRelative(filePath) {
    const normalized = normalizePath(filePath);
    const abs = path.isAbsolute(normalized) ? normalized : path.resolve(normalized);
    let dir = path.dirname(abs);
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.agenfk', 'project.json'))) {
            return path.relative(dir, abs).split(path.sep).join('/');
        }
        dir = path.dirname(dir);
    }
    return null;
}

/**
 * Cards that still own this path and are NOT being worked.
 *
 * WHAT THIS CANNOT DO, stated because the docs once claimed otherwise: it
 * cannot tell which card the editing agent belongs to. The hook receives a
 * tool call, not an identity, and several agents share one machine and one
 * worktree - so when an ACTIVE card holds the file, this cannot know whether
 * the agent at the keyboard is that card's or somebody else's, and allows.
 *
 * What it can answer without identity is the unambiguous half: a card that
 * holds the file and is parked - TODO, PAUSED, BLOCKED - has an agent that is
 * not editing right now, so nobody should be. That case is a refusal.
 */
function parkedHoldersOf(relPath, items) {
    if (!relPath) return [];
    return items.filter(i => {
        const status = (i.status ?? '').toUpperCase();
        if (RELEASED_STATUSES.has(status)) return false;
        if (!INACTIVE_STATUSES.has(status)) return false;   // being worked - see above
        return Array.isArray(i.claims) && i.claims.some(c => claimsCollide(relPath, c));
    });
}

async function checkInProgress() {
    return new Promise((resolve) => {
        // Fetch all items without a status filter so custom coding-step names
        // (e.g. 'create_unit_tests' in a TDD flow) are recognised as active.
        const req = http.get(`${API_URL}/items`, { timeout: 2000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve({ hasActive: true, items: [] }); // Graceful skip on API issues
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const items = JSON.parse(data);
                    const list = Array.isArray(items) ? items : [];
                    const hasActive = list.some(
                        i => !INACTIVE_STATUSES.has((i.status ?? '').toUpperCase())
                    );
                    resolve({ hasActive, items: list });
                } catch (e) {
                    resolve({ hasActive: true, items: [] }); // Graceful skip on parse error
                }
            });
        });

        req.on('error', () => resolve({ hasActive: true, items: [] })); // Graceful skip on connection error
        req.on('timeout', () => {
            req.destroy();
            resolve({ hasActive: true, items: [] });
        });
    });
}

async function main() {
    const toolIntent = await getToolIntent();

    // Extract file path from tool input (Edit/Write use file_path, NotebookEdit uses notebook_path)
    const filePath = toolIntent?.tool_input?.file_path || toolIntent?.tool_input?.notebook_path || null;

    // Only enforce workflow for files inside an AgenFK-managed project directory
    if (!isInsideAgenFKProject(filePath)) {
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

    const { hasActive, items } = await checkInProgress();

    // The claim check runs FIRST on the unambiguous case: a parked card's
    // files are nobody's to edit, whether or not some other card is active.
    const parked = parkedHoldersOf(repoRelative(filePath), items);
    if (parked.length) {
        const who = parked.map(i => `  [${String(i.id).slice(0, 8)}] ${i.title} (${i.status})`).join('\n');
        process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: `AgenFK CLAIM CONFLICT: this file is owned by a card that is not being worked.\n\n${who}\n\n`
                + `Its agent stopped mid-edit and the file is still half-finished in this shared worktree; `
                + `editing it now overwrites work nobody is watching. Resume that card, or have it release the path with `
                + `\`agenfk update <id> --claims ""\`.`,
        }));
        process.exit(0);
    }

    if (!hasActive) {
        const toolName = toolIntent?.tool || 'unknown tool';
        const reason = `AgenFK WORKFLOW VIOLATION: No task is actively being worked on while attempting to use ${toolName}.\n\nBefore modifying files you must have a task in an active coding step (e.g. IN_PROGRESS, create_unit_tests, or your flow's first working step).\n\n  1. Create a task:  agenfk create item --type TASK --title "<title>"\n  2. Start it:       agenfk verify <id>  (advances from TODO to the coding step)\n\nThen retry your change.`;

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
        const url = new URL(import.meta.url);
        return process.argv[1] && url.pathname === process.argv[1];
    } catch { return false; }
})();
if (isMain) {
    main().catch(() => process.exit(0));
}
