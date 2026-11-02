/**
 * AgenFK MCP Enforcer — Opencode plugin (tool.execute.before hook)
 *
 * Blocks the two routes around the AgEnFK server (the single owner of state):
 *   1. Direct database reads  — .agenfk/db.sqlite or .agenfk/db.json via bash or read
 *   2. Direct REST API calls  — curl/wget to localhost:3000 or 127.0.0.1:3000
 *
 * The `agenfk` CLI and the MCP tools are interchangeable ways in, so neither is
 * blocked (BUG ec325925).
 *
 * Installed to ~/.config/opencode/plugins/ during agenfk install/upgrade.
 */

import fs from 'fs';
import path from 'path';

/** How to read state instead: the CLI first, MCP as its equivalent. */
const INSTEAD =
    '\nRead and change state through the agenfk CLI instead: agenfk list --project <id> --json • agenfk get <id> --json • ' +
    'agenfk create ... • agenfk update <id> ... • agenfk verify <id> ... (or the equivalent agenfk MCP tools, when installed with --with-mcp).';

// project.json (shared settings) or local.json (this machine's id, CGLAB-625) marks a project.
function isInsideAgenFKProjectDir(dirPath) {
    if (!dirPath) return false;
    let dir = dirPath;
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.agenfk', 'project.json')) || fs.existsSync(path.join(dir, '.agenfk', 'local.json'))) return true;
        dir = path.dirname(dir);
    }
    return false;
}

/** The command a tool is about to run, whatever the tool is called ('' when none). */
function toolCommand(args) {
    for (const v of [args.command, args.cmd]) if (typeof v === 'string' && v.trim()) return v;
    return '';
}

/** The file a tool is about to touch, whatever the tool is called ('' when none). */
function toolPath(args) {
    for (const v of [args.filePath, args.file_path, args.path]) if (typeof v === 'string' && v.trim()) return v;
    return '';
}

export default async function agenfkMcpEnforcer(context) {
    return {
        // OpenCode passes the tool's arguments on the SECOND parameter
        // (`output.args`, @opencode-ai/plugin); `input.args` is kept for older
        // callers. Reading only `input.args` made this plugin a no-op.
        'tool.execute.before': async (input, output) => {
            const args = output?.args || input?.args || {};
            const cwd = context?.directory || process.cwd();

            // ── command checks ──────────────────────────────────────────────────
            // A tool is judged by what it carries, not by its name: plugin tools
            // (bash_bg, a custom shell…) run commands too.
            const command = toolCommand(args);
            if (command) {
                // 1. Block direct database access
                if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(command)) {
                    throw new Error(
                        'AgenFK MCP ENFORCER: Direct database access is forbidden.\n' +
                        'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via Bash.' +
                        INSTEAD
                    );
                }

                // 2. Block direct REST API calls to the AgenFK server
                if (/\b(curl|wget)\b[\s\S]*\b(localhost:3000|127\.0\.0\.1:3000)\b/.test(command)) {
                    if (isInsideAgenFKProjectDir(cwd)) {
                        throw new Error(
                            'AgenFK MCP ENFORCER: Direct REST API calls to the AgenFK server are forbidden.\n' +
                            'Do NOT use curl/wget to http://localhost:3000.' +
                            INSTEAD
                        );
                    }
                }
            }

            // ── path checks: any tool that names a file, read or otherwise ─────
            // Checked even when the tool also carries a command: a harmless
            // command must not carry a database path through with it.
            const filePath = toolPath(args);
            if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(filePath)) {
                throw new Error(
                    'AgenFK MCP ENFORCER: Direct reads of AgenFK database files are forbidden.\n' +
                    'Do NOT read .agenfk/db.sqlite or .agenfk/db.json.' +
                    INSTEAD
                );
            }
        }
    };
}
