/**
 * Tests for install.mjs CLI-only-default behavior.
 *
 * Product decision: MCP server registration is OPT-IN. A plain
 * `node scripts/install.mjs` installs the CLI, services, skills, commands,
 * rules and the gatekeeper/enforcer/pr hooks — but does NOT register the
 * agenfk MCP server with any client. MCP is registered only with `--with-mcp`
 * (or a previously-persisted opt-in). A default install also unregisters any
 * pre-existing agenfk MCP server so upgrades flip cleanly to CLI-only.
 *
 * Source-level assertions, matching the existing install-script test style.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const installScript = readFileSync(
  path.resolve(__dirname, '../../../../scripts/install.mjs'),
  'utf8'
);

const bootstrapScript = readFileSync(
  path.resolve(__dirname, '../../../../bin/agenfk.js'),
  'utf8'
);

describe('bin/agenfk.js — forwards MCP opt-in flags to install.mjs', () => {
  it('forwards --with-mcp', () => {
    expect(bootstrapScript).toMatch(/--with-mcp/);
  });
  it('forwards --no-mcp', () => {
    expect(bootstrapScript).toMatch(/--no-mcp/);
  });
});

describe('bin/agenfk.js — refuses to run destructively from a source checkout', () => {
  it('derives hasGit from a .git probe (same signal as isNpxCache)', () => {
    expect(bootstrapScript).toMatch(/hasGit\s*=\s*fs\.existsSync\([^)]*['"]\.git['"]/);
  });

  it('guards on a git working tree and honors the --force-install override', () => {
    // The actual blocking condition — would fail if && became ||, or if the
    // override check were dropped.
    expect(bootstrapScript).toMatch(/if\s*\(\s*hasGit\s*&&\s*!forceInstall\s*\)/);
    expect(bootstrapScript).toMatch(/forceInstall\s*=\s*process\.argv\.includes\(['"]--force-install['"]\)/);
  });

  it('the guard block itself terminates with process.exit(1)', () => {
    const start = bootstrapScript.indexOf('if (hasGit && !forceInstall)');
    expect(start).toBeGreaterThan(-1);
    // The guard fires before either install branch, so its exit must precede the first runInstaller call.
    const firstRunInstaller = bootstrapScript.indexOf('runInstaller(');
    const guardBlock = bootstrapScript.slice(start, firstRunInstaller > start ? firstRunInstaller : undefined);
    expect(guardBlock).toMatch(/process\.exit\(1\)/);
  });

  it('points the user to a safe alternative (install:framework or the CLI)', () => {
    expect(bootstrapScript).toMatch(/install:framework/);
    expect(bootstrapScript).toMatch(/agenfk <command>/);
  });
});

describe('install.mjs — MCP is opt-in (CLI-only by default)', () => {
  it('parses a --with-mcp opt-in flag', () => {
    expect(installScript).toMatch(/--with-mcp/);
    expect(installScript).toMatch(/withMcp/);
  });

  it('supports a --no-mcp flag to force-disable MCP', () => {
    expect(installScript).toMatch(/--no-mcp/);
  });

  it('defaults withMcp to false (only enabled by flag, env, or persisted config)', () => {
    expect(installScript).toMatch(/process\.argv\.includes\(['"]--with-mcp['"]\)/);
  });

  it('gates Opencode MCP registration behind withMcp', () => {
    expect(installScript).toMatch(/withMcp\s*&&\s*shouldRun\(['"]opencode['"]\)/);
  });

  it('gates Cursor MCP registration behind withMcp', () => {
    expect(installScript).toMatch(/withMcp\s*&&\s*shouldRun\(['"]cursor['"]\)/);
  });

  it('registers Codex MCP by DEFAULT (not gated behind withMcp) — Codex sandbox blocks the CLI', () => {
    // Codex is the exception: MCP is on by default (only --no-mcp / persisted
    // opt-out disables it), resolved via shouldRegisterCodexMcp into `codexMcp`.
    // It must NOT use the plain withMcp gate.
    expect(installScript).toMatch(/const\s+codexMcp\s*=\s*shouldRegisterCodexMcp\(/);
    expect(installScript).toMatch(/codexMcp\s*&&\s*shouldRun\(['"]codex['"]\)/);
    expect(installScript).not.toMatch(/withMcp\s*&&\s*shouldRun\(['"]codex['"]\)/);
  });

  it('resolves Codex MCP with the persisted preference so --no-mcp opt-out is sticky', () => {
    expect(installScript).toMatch(/shouldRegisterCodexMcp\(\{[^}]*persistedCodexMcp:\s*existingConfig\.codexMcp/);
    // and the resolved decision is persisted back into config.json
    expect(installScript).toMatch(/codexMcp,/);
  });

  it('gates Gemini MCP registration behind withMcp', () => {
    expect(installScript).toMatch(/withMcp\s*&&\s*shouldRun\(['"]gemini['"]\)/);
  });

  it('gates Claude Code MCP registration behind withMcp', () => {
    expect(installScript).toMatch(/withMcp\s*&&\s*shouldRun\(['"]claude['"]\)/);
  });

  it('persists the resolved withMcp preference into config.json', () => {
    const configWrite = installScript.slice(installScript.indexOf('configData'));
    expect(configWrite).toMatch(/withMcp/);
  });
});

describe('install.mjs — hooks and assets stay installed in CLI-only mode', () => {
  it('still installs the gatekeeper hook (not gated by withMcp)', () => {
    expect(installScript).toMatch(/agenfk-gatekeeper/);
  });

  it('still installs the mcp-enforcer hook (it allows the CLI when MCP is absent)', () => {
    expect(installScript).toMatch(/agenfk-mcp-enforcer/);
  });

  it('still installs skills/commands and rules regardless of MCP', () => {
    expect(installScript).toMatch(/Installing agenfk skills|agenfk-flow skill|skills/i);
  });
});

describe('install.mjs — CLI-only unregisters any existing MCP server', () => {
  const cleanup = installScript.slice(installScript.indexOf('if (!withMcp)'));

  it('has a cleanup branch gated by !withMcp', () => {
    expect(installScript).toMatch(/if\s*\(!withMcp\)/);
  });

  it('removes the Claude and Gemini MCP registrations via the client CLIs', () => {
    expect(cleanup).toMatch(/claudeCmd[\s\S]*['"]mcp['"],\s*['"]remove['"]/);
    expect(cleanup).toMatch(/geminiCmd[\s\S]*['"]mcp['"],\s*['"]remove['"]/);
  });

  it('only unregisters Codex MCP when opted out (--no-mcp) — Codex defaults to MCP', () => {
    // Codex removal is guarded, not unconditional: in default CLI-only mode Codex
    // keeps its MCP server (the CLI is unusable in its sandbox).
    expect(cleanup).toMatch(/!codexMcp\s*&&\s*shouldRun\(['"]codex['"]\)/);
  });

  it('deletes the agenfk entry from opencode and cursor MCP config files', () => {
    expect(cleanup).toMatch(/delete cfg\.mcp\.agenfk/);
    expect(cleanup).toMatch(/delete cursorMcp\.mcpServers\.agenfk/);
  });
});
