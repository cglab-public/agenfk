/**
 * AgenFK Gatekeeper — Opencode plugin (tool.execute.before hook)
 *
 * Blocks Edit/Write/NotebookEdit if no task is IN_PROGRESS.
 * Delegates logic to the shared agenfk-gatekeeper.mjs script.
 *
 * Installed to ~/.config/opencode/plugins/ during agenfk install/upgrade.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

const GATEKEEPER_BIN = path.join(os.homedir(), '.agenfk', 'bin', 'agenfk-gatekeeper.mjs');

// A patch names its files in header lines (OpenCode's packages/util/src/patch.ts).
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const PATCH_BEGIN = /^\*\*\* Begin Patch\s*$/m;

// Not exported: OpenCode calls every function a plugin module exports as a plugin.
/** Every distinct file a patch touches, or [] when the text names none. */
function patchTargets(text) {
    return [...new Set([...text.matchAll(PATCH_HEADER)].map((m) => m[1].trim()).filter(Boolean))];
}

/**
 * The patch a tool carries, whatever the tool is called: OpenCode's `patch`
 * (and the older `apply_patch`) use patchText. Only a real patch envelope
 * counts, so text that merely mentions a header is not mistaken for a write.
 */
function toolPatch(args) {
    for (const v of [args.patchText, args.patch, args.input]) {
        if (typeof v === 'string' && PATCH_BEGIN.test(v) && patchTargets(v).length) return v;
    }
    return '';
}

/** Throw the gatekeeper's block for one file; never break the host on internal failures. */
function gate(tool, filePath) {
    try {
        const result = spawnSync('node', [GATEKEEPER_BIN], {
            input: JSON.stringify({
                tool,
                tool_input: {
                    file_path: filePath,
                    notebook_path: filePath
                }
            }),
            encoding: 'utf8',
            timeout: 2500,
            windowsHide: true,
        });

        const out = (result.stdout || '').trim();
        if (!out) return;

        try {
            const parsed = JSON.parse(out);
            if (parsed?.decision === 'block') {
                throw new Error(parsed.reason);
            }
        } catch (e) {
            if (e.message.includes('AgenFK WORKFLOW VIOLATION')) throw e;
            /* malformed JSON or other error — ignore */
        }
    } catch (e) {
        if (e.message.includes('AgenFK WORKFLOW VIOLATION')) throw e;
        /* hook should never break the host on internal failures */
    }
}

export default async function agenfkGatekeeperOpencode(context) {
    // OpenCode applies a patch relative to its workspace, which need not be the
    // host process's own directory: the gatekeeper is asked about that file.
    const workspace = context?.directory || process.cwd();
    return {
        // OpenCode passes the arguments on `output.args` (@opencode-ai/plugin);
        // `input.args` is kept for older callers.
        'tool.execute.before': async (input, output) => {
            const tool = (input.tool || '').toLowerCase();
            const args = output?.args || input.args || {};

            // A patch is gated by every file it touches, whatever the tool is
            // called (BUG 59d3ad7c): it names them in its text, not in a path.
            const patch = toolPatch(args);
            if (patch) {
                for (const target of patchTargets(patch)) gate(input.tool, path.resolve(workspace, target));
                return;
            }

            if (tool !== 'edit' && tool !== 'write' && tool !== 'notebookedit') return;
            const filePath = args.filePath || args.file_path || args.notebookPath || args.notebook_path || '';
            if (!filePath) return;
            gate(input.tool, filePath);
        },
    };
}
