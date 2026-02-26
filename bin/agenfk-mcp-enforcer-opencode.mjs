/**
 * AgenFK MCP Enforcer — Opencode plugin (tool.execute.before hook)
 *
 * Blocks all three bypass routes that agents use instead of MCP tool calls:
 *   1. Direct database reads  — .agenfk/db.sqlite or .agenfk/db.json via bash or read
 *   2. Direct REST API calls  — curl/wget to localhost:3000 or 127.0.0.1:3000
 *   3. CLI state queries      — agenfk list/status/get/show, npx agenfk, etc.
 *
 * Installed to ~/.config/opencode/plugins/ during agenfk install/upgrade.
 */

import fs from 'fs';
import path from 'path';

const FALLBACK_FLAG = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.agenfk', 'mcp-fallback-approved'
);
const FALLBACK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isFallbackApproved() {
    try {
        if (!fs.existsSync(FALLBACK_FLAG)) return false;
        const ageMs = Date.now() - fs.statSync(FALLBACK_FLAG).mtimeMs;
        if (ageMs < FALLBACK_TTL_MS) return true;
        fs.unlinkSync(FALLBACK_FLAG); // expired — clean up
        return false;
    } catch {
        return false;
    }
}

const FALLBACK_INSTRUCTIONS =
    '\nIf MCP tools are genuinely unavailable: tell the user and ask permission. ' +
    'Once approved, run: touch ~/.agenfk/mcp-fallback-approved (expires in 5 min).';

function isInsideAgenFKProjectDir(dirPath) {
    if (!dirPath) return false;
    let dir = dirPath;
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.agenfk', 'project.json'))) return true;
        dir = path.dirname(dir);
    }
    return false;
}

export default async function agenfkMcpEnforcer(context) {
    return {
        'tool.execute.before': async (input) => {
            // If user has approved fallback, allow bypass for this window
            if (isFallbackApproved()) return;

            const tool = (input.tool || '').toLowerCase();
            const args = input.args || {};
            const cwd = context?.directory || process.cwd();

            // ── bash tool checks ────────────────────────────────────────────────
            if (tool === 'bash' || tool === 'execute') {
                const command = args.command || '';

                // 1. Block direct database access
                if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(command)) {
                    throw new Error(
                        'AgenFK MCP ENFORCER: Direct database access is forbidden.\n' +
                        'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via Bash.\n' +
                        'Use MCP tool invocations: list_items() • get_item() • create_item() • update_item()' +
                        FALLBACK_INSTRUCTIONS
                    );
                }

                // 2. Block direct REST API calls to the AgenFK server
                if (/\b(curl|wget)\b[\s\S]*\b(localhost:3000|127\.0\.0\.1:3000)\b/.test(command)) {
                    if (isInsideAgenFKProjectDir(cwd)) {
                        throw new Error(
                            'AgenFK MCP ENFORCER: Direct REST API calls to the AgenFK server are forbidden.\n' +
                            'Do NOT use curl/wget to http://localhost:3000.\n' +
                            'Use MCP tool invocations: list_items() • create_item() • update_item() • verify_changes()' +
                            FALLBACK_INSTRUCTIONS
                        );
                    }
                }

                // 3. Block agenfk CLI state query commands
                if (/\bagenfk\s+(list|status|get|show|board)\b/.test(command) ||
                    /\bnpx\s+agenfk\s+(list|status|get|show|board)\b/.test(command)) {
                    throw new Error(
                        'AgenFK MCP ENFORCER: agenfk CLI state queries are forbidden.\n' +
                        'Do NOT use: agenfk list, agenfk status, agenfk get, npx agenfk ...\n' +
                        'Use MCP tool invocations: list_items() • get_item() • list_projects()' +
                        FALLBACK_INSTRUCTIONS
                    );
                }
            }

            // ── read tool checks ────────────────────────────────────────────────
            if (tool === 'read') {
                const filePath = args.filePath || args.file_path || '';

                if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(filePath)) {
                    throw new Error(
                        'AgenFK MCP ENFORCER: Direct reads of AgenFK database files are forbidden.\n' +
                        'Do NOT read .agenfk/db.sqlite or .agenfk/db.json.\n' +
                        'Use MCP tool invocations: list_items() • get_item() • create_item() • update_item()' +
                        FALLBACK_INSTRUCTIONS
                    );
                }
            }
        }
    };
}
