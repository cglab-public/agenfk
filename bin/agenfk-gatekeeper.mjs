#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';

const API_URL = process.env.AGENFK_API_URL || 'http://127.0.0.1:3000';

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

async function checkInProgress() {
    return new Promise((resolve) => {
        const req = http.get(`${API_URL}/items?status=IN_PROGRESS`, { timeout: 2000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve(true); // Graceful skip on API issues
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const items = JSON.parse(data);
                    const hasActive = Array.isArray(items) && items.some(i => i.status === 'IN_PROGRESS');
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
    const reason = `AgenFK WORKFLOW VIOLATION: No task is IN_PROGRESS while attempting to use ${toolName}.\n\nBefore modifying files you must:\n  1. Create a task:  agenfk create item --type TASK --title "<title>"\n  2. Start it:       agenfk update <id> --status IN_PROGRESS\n\nThen retry your change.`;

    process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: reason
    }));
}

process.exit(0);
