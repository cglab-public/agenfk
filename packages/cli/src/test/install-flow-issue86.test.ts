/**
 * Behavioral tests for issue #86 — the fresh-install flow is broken on a clean
 * (often non-interactive) machine. These exercise real behavior, not source text:
 *   #1 npx must be able to resolve a default bin from the published package
 *   #2 the rules-scope decision must never block on a prompt under non-TTY stdin
 *   #4 the "source <rc>" hint must only appear when an rc file was actually modified
 *   #6 `agenfk --version` (and `-V`) must print the version and exit 0
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { resolveRulesScope, shellSourceHint, normalizeScope } from '../../../../scripts/install-helpers.mjs';

const ROOT = path.resolve(__dirname, '../../../..');

// ---------------------------------------------------------------------------
// #1 — npx entrypoint resolves a default bin
// ---------------------------------------------------------------------------
// `npx github:cglab-public/agenfk` auto-runs a bin only when (a) exactly one bin
// is declared, or (b) a bin key matches the package name. With two bins and a
// non-matching name, npm errors "could not determine executable to run".
describe('issue #86 #1 — package.json is npx-resolvable', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  it('declares a bin npx can pick by default (single bin OR a bin named after the package)', () => {
    const binKeys = Object.keys(pkg.bin ?? {});
    expect(binKeys.length).toBeGreaterThan(0);
    const npxResolvable = binKeys.length === 1 || binKeys.includes(pkg.name);
    expect(npxResolvable).toBe(true);
  });

  it('keeps the agenfk bin available regardless of how resolution happens', () => {
    expect(Object.keys(pkg.bin ?? {})).toContain('agenfk');
  });
});

// ---------------------------------------------------------------------------
// #2 — rules-scope resolution is non-TTY safe
// ---------------------------------------------------------------------------
describe('issue #86 #2 — resolveRulesScope never prompts on non-interactive stdin', () => {
  it('defaults to global WITHOUT prompting when stdin is not a TTY and nothing is configured', () => {
    const r = resolveRulesScope({ rulesScopeArg: undefined, envScope: undefined, existingScope: undefined, isTTY: false });
    expect(r.shouldPrompt).toBe(false);
    expect(r.scope).toBe('global');
  });

  it('prompts (with global default) only when interactive and nothing is preset', () => {
    const r = resolveRulesScope({ rulesScopeArg: undefined, envScope: undefined, existingScope: undefined, isTTY: true });
    expect(r.shouldPrompt).toBe(true);
  });

  it('honors the --rules-scope flag over everything, no prompt, even on a TTY', () => {
    const r = resolveRulesScope({ rulesScopeArg: 'project', envScope: undefined, existingScope: 'global', isTTY: true });
    expect(r).toEqual({ scope: 'project', shouldPrompt: false });
  });

  it('honors the AGENFK_RULES_SCOPE env var when no flag is given', () => {
    const r = resolveRulesScope({ rulesScopeArg: undefined, envScope: 'project', existingScope: undefined, isTTY: false });
    expect(r).toEqual({ scope: 'project', shouldPrompt: false });
  });

  it('reuses an existing config value without prompting', () => {
    const r = resolveRulesScope({ rulesScopeArg: undefined, envScope: undefined, existingScope: 'project', isTTY: true });
    expect(r).toEqual({ scope: 'project', shouldPrompt: false });
  });

  it('ignores an invalid scope value and falls back to the non-TTY default', () => {
    const r = resolveRulesScope({ rulesScopeArg: 'bogus', envScope: '', existingScope: undefined, isTTY: false });
    expect(r).toEqual({ scope: 'global', shouldPrompt: false });
  });

  it('normalizeScope canonicalizes case/whitespace and rejects junk', () => {
    expect(normalizeScope('  PROJECT ')).toBe('project');
    expect(normalizeScope('Global')).toBe('global');
    expect(normalizeScope('nonsense')).toBe(null);
    expect(normalizeScope(undefined)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// #4 — source hint only when an rc file was modified
// ---------------------------------------------------------------------------
describe('issue #86 #4 — shellSourceHint is conditional on an rc edit', () => {
  it('returns null when no rc file was modified', () => {
    expect(shellSourceHint({ rcModified: false, shell: 'bash' })).toBe(null);
  });

  it('returns a shell-appropriate hint when an rc file was modified', () => {
    expect(shellSourceHint({ rcModified: true, shell: 'zsh' })).toBe('source ~/.zshrc');
    expect(shellSourceHint({ rcModified: true, shell: 'bash' })).toBe('source ~/.bashrc');
  });
});

// ---------------------------------------------------------------------------
// #6 — `agenfk --version` works (long form, the convention everyone types)
// ---------------------------------------------------------------------------
describe('issue #86 #6 — CLI exposes --version', () => {
  const cliEntry = path.join(ROOT, 'packages/cli/dist/index.js');
  // The CLI reports its own package version (packages/cli/package.json) — that's the
  // source of truth for `agenfk --version`, independent of release version-sync.
  const version = JSON.parse(readFileSync(path.join(ROOT, 'packages/cli/package.json'), 'utf8')).version;

  beforeAll(() => {
    if (!existsSync(cliEntry)) {
      spawnSync('npm', ['run', 'build', '-w', 'packages/cli'], { cwd: ROOT, stdio: 'inherit' });
    }
  });

  function runCli(args: string[]) {
    return spawnSync('node', [cliEntry, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    });
  }

  it('prints the version and exits 0 for --version', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toContain(version);
    expect(r.stderr).not.toMatch(/unknown option/i);
  });

  it('still supports the -V short flag', () => {
    const r = runCli(['-V']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toContain(version);
  });
});
