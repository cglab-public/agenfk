/**
 * Regression tests for two defects that silently disabled the Claude Code
 * hooks while every existing test stayed green:
 *
 * 1. Entry detection. bin/agenfk-gatekeeper.mjs and bin/agenfk-pr-hook.mjs only
 *    run main() when executed directly, and decided that by comparing
 *    `new URL(import.meta.url).pathname` to `process.argv[1]` as strings. On
 *    Windows the pathname is `/C:/...` and argv[1] is `C:\...`, so the hook
 *    exited 0 without enforcing anything. The same string compare also broke
 *    for a relative argv[1] or a symlinked script on any OS, which is how these
 *    tests reproduce it on Linux CI too.
 *
 * 2. Payload shape. Claude Code sends the tool as `tool_name`, but
 *    bin/agenfk-mcp-enforcer.mjs only read `tool`, so none of its Bash/Read
 *    rules ever fired under Claude Code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN_DIR = path.resolve(__dirname, '../../../../bin');
const ENFORCER = path.join(BIN_DIR, 'agenfk-mcp-enforcer.mjs');
const PR_HOOK = path.join(BIN_DIR, 'agenfk-pr-hook.mjs');

function run(scriptArg: string, payload: unknown, opts: { cwd?: string; args?: string[] } = {}) {
  return spawnSync(process.execPath, [scriptArg, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function decisionOf(stdout: string): string | undefined {
  const out = stdout.trim();
  return out ? JSON.parse(out).decision : undefined;
}

describe('agenfk-mcp-enforcer reads the Claude Code payload shape (tool_name)', () => {
  it('blocks a direct DB read via Bash when the tool arrives as tool_name', () => {
    const res = run(ENFORCER, { tool_name: 'Bash', tool_input: { command: 'cat .agenfk/db.sqlite' } });
    expect(res.status).toBe(0);
    expect(decisionOf(res.stdout)).toBe('block');
  });

  it('blocks a direct DB read via the Read tool when the tool arrives as tool_name', () => {
    const res = run(ENFORCER, { tool_name: 'Read', tool_input: { file_path: '/repo/.agenfk/db.sqlite' } });
    expect(decisionOf(res.stdout)).toBe('block');
  });

  it('still accepts the legacy `tool` field', () => {
    const res = run(ENFORCER, { tool: 'Bash', tool_input: { command: 'cat .agenfk/db.json' } });
    expect(decisionOf(res.stdout)).toBe('block');
  });

  it('allows an unrelated command', () => {
    const res = run(ENFORCER, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});

describe('hook entry detection runs main() however the script path is spelled', () => {
  const openPayload = { tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } };
  let linkDir: string;

  beforeAll(() => { linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hook-entry-')); });
  afterAll(() => { try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('runs when invoked by absolute path', () => {
    const res = run(PR_HOOK, openPayload);
    expect(res.stdout).toContain('register_pr');
  });

  it('runs when invoked by a relative path', () => {
    const res = run('agenfk-pr-hook.mjs', openPayload, { cwd: BIN_DIR });
    expect(res.stdout).toContain('register_pr');
  });

  it('runs when invoked with a backslash / differently-cased path on Windows', () => {
    if (process.platform !== 'win32') return;
    // Flip the drive-letter case and use backslashes; keep the `.mjs` extension
    // intact, since node only treats a lowercase `.mjs` as ESM.
    const drive = PR_HOOK[0] === PR_HOOK[0].toUpperCase() ? PR_HOOK[0].toLowerCase() : PR_HOOK[0].toUpperCase();
    const res = run(drive + PR_HOOK.slice(1).replace(/\//g, '\\'), openPayload);
    expect(res.stdout).toContain('register_pr');
  });

  it('runs when invoked through a symlink', () => {
    const link = path.join(linkDir, 'agenfk-pr-hook.mjs');
    try {
      fs.symlinkSync(PR_HOOK, link);
    } catch {
      return; // Symlinks need elevated rights on some Windows setups.
    }
    const res = run(link, openPayload);
    expect(res.stdout).toContain('register_pr');
  });

  it('does not run main() when imported as a module', async () => {
    // Importing must be side-effect free: main() would block on stdin and exit.
    // @ts-ignore — .mjs hook has no .d.ts.
    const mod = await import('../../../../bin/agenfk-pr-hook.mjs');
    expect(typeof mod.classifyTrigger).toBe('function');
  });
});
