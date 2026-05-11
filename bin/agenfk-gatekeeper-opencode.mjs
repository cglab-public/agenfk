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

export default async function agenfkGatekeeperOpencode(_context) {
    return {
        'tool.execute.before': async (input) => {
            const tool = (input.tool || '').toLowerCase();
            if (tool !== 'edit' && tool !== 'write' && tool !== 'notebookedit') return;

            const args = input.args || {};
            const filePath = args.filePath || args.file_path || args.notebookPath || args.notebook_path || '';
            if (!filePath) return;

            try {
                const result = spawnSync('node', [GATEKEEPER_BIN], {
                    input: JSON.stringify({ 
                        tool: input.tool, 
                        tool_input: { 
                            file_path: filePath,
                            notebook_path: filePath
                        } 
                    }),
                    encoding: 'utf8',
                    timeout: 2500,
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
        },
    };
}
