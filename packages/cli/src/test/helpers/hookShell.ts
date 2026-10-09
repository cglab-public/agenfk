import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** The shell Claude Code runs hooks with: Git Bash on Windows (never WSL's bash.exe), bash elsewhere. */
export function hookShell(): string {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    (() => {
      try {
        const git = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim();
        return path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
      } catch { return undefined; }
    })(),
  ];
  const found = candidates.find((c): c is string => !!c && fs.existsSync(c));
  // Never a silent skip: without Git Bash a test cannot say whether the hooks run.
  if (!found) throw new Error(`Git Bash not found (looked in: ${candidates.filter(Boolean).join(', ')})`);
  return found;
}
