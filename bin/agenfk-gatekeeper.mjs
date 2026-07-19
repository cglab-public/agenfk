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

async function checkInProgress() {
    return new Promise((resolve) => {
        // Fetch all items without a status filter so custom coding-step names
        // (e.g. 'create_unit_tests' in a TDD flow) are recognised as active.
        const req = http.get(`${API_URL}/items`, { timeout: 2000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve(true); // Graceful skip on API issues
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const items = JSON.parse(data);
                    const hasActive = Array.isArray(items) && items.some(
                        i => !INACTIVE_STATUSES.has((i.status ?? '').toUpperCase())
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

    const hasInProgress = await checkInProgress();

    if (!hasInProgress) {
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
