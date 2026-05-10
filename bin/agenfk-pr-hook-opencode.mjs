/**
 * AgEnFK PR sizing hook — OpenCode plugin variant. Runs as a `tool.execute.after`
 * plugin under ~/.config/opencode/plugins/. Mirrors the standalone agenfk-pr-hook.mjs
 * shell-script version but emits the directive via the OpenCode plugin context
 * rather than stdout.
 *
 * Installed by scripts/install.mjs.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

const HOOK_BIN = path.join(os.homedir(), '.agenfk', 'bin', 'agenfk-pr-hook.mjs');

export default async function agenfkPrHookOpencode(_context) {
  return {
    'tool.execute.after': async (input) => {
      const tool = (input.tool || '').toLowerCase();
      if (tool !== 'bash' && tool !== 'execute') return;
      const command = input?.args?.command || '';
      if (!command) return;
      // Delegate classification + directive shape to the shared script.
      try {
        const result = spawnSync('node', [HOOK_BIN, '--client', 'opencode'], {
          input: JSON.stringify({ args: { command } }),
          encoding: 'utf8',
          timeout: 1500,
        });
        const out = (result.stdout || '').trim();
        if (!out) return;
        try {
          const parsed = JSON.parse(out);
          if (parsed?.message) {
            // OpenCode plugins surface notes via a console-style log; the agent
            // sees the directive in its tool-call output stream.
            console.log(`[agenfk-pr-hook] ${parsed.message}`);
          }
        } catch { /* malformed output — ignore */ }
      } catch { /* hook should never break the host */ }
    },
  };
}
