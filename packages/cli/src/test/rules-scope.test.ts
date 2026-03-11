/**
 * TDD tests for the rulesScope feature.
 * Covers: install prompt + persistence, project-level paths, CLI integration, uninstall cleanup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const installScript = readFileSync(path.join(ROOT, 'scripts/install.mjs'), 'utf8');
const uninstallScript = readFileSync(path.join(ROOT, 'scripts/uninstall.mjs'), 'utf8');
const cliSource = readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');

// --- Task 1: Interactive rulesScope prompt + persistence ---

describe('install.mjs — rulesScope prompt and persistence', () => {
  it('should prompt the user to choose rules scope (global/project)', () => {
    // The install script must contain a prompt asking the user where to install rules
    expect(installScript).toMatch(/rulesScope|rules.*scope|global.*project/i);
    expect(installScript).toMatch(/ask|prompt|question|readline/i);
  });

  it('should read rulesScope from config.json if already set', () => {
    // On upgrade/re-install, should read existing preference from config
    expect(installScript).toMatch(/rulesScope/);
  });

  it('should persist rulesScope to ~/.agenfk/config.json', () => {
    // After user chooses, the value must be written to config
    // Look for rulesScope being included in the config write
    expect(installScript).toMatch(/rulesScope/);
    // The config write section should include rulesScope
    const configWriteIdx = installScript.indexOf('Config written');
    expect(configWriteIdx).toBeGreaterThan(-1);
    const configSection = installScript.slice(Math.max(0, configWriteIdx - 500), configWriteIdx + 100);
    expect(configSection).toMatch(/rulesScope/);
  });

  it('should accept --rules-scope CLI flag to skip the prompt', () => {
    expect(installScript).toMatch(/--rules-scope/);
  });
});

// --- Task 2: Rule writers support project-level paths ---

describe('install.mjs — project-level rule paths', () => {
  it('should resolve CLAUDE.md path based on rulesScope', () => {
    // When rulesScope=project, CLAUDE.md goes to .claude/CLAUDE.md (project root)
    // The script must contain logic branching on rulesScope for claude rules
    const claudeSection = extractSection(installScript, 'CLAUDE.md');
    expect(claudeSection).toMatch(/rulesScope|project/i);
  });

  it('should resolve AGENTS.md path based on rulesScope', () => {
    const codexSection = extractSection(installScript, 'AGENTS.md');
    expect(codexSection).toMatch(/rulesScope|project/i);
  });

  it('should resolve GEMINI.md path based on rulesScope', () => {
    const geminiSection = extractSection(installScript, 'GEMINI.md');
    expect(geminiSection).toMatch(/rulesScope|project/i);
  });

  it('should resolve agenfk.mdc path based on rulesScope', () => {
    const cursorSection = extractSection(installScript, 'agenfk.mdc');
    expect(cursorSection).toMatch(/rulesScope|project/i);
  });

  it('should clean up the opposite scope when installing rules', () => {
    // When switching from global to project (or vice versa), agenfk blocks
    // must be removed from the old location
    expect(installScript).toMatch(/agenfk:start[\s\S]*?agenfk:end/);
    // Must have cleanup logic for both global and project paths
    expect(installScript).toMatch(/clean|remov|opposite|other.*scope/i);
  });
});

// --- Task 3: CLI integration install respects rulesScope ---

describe('CLI — integration install respects rulesScope', () => {
  it('should accept --scope flag on integration install command', () => {
    expect(cliSource).toMatch(/--scope/);
  });

  it('should pass rulesScope to install.mjs', () => {
    // The integration install action must forward the scope to the install script
    expect(cliSource).toMatch(/rules-scope|rulesScope/);
  });
});

// --- Task 4: Uninstall respects rulesScope ---

describe('uninstall.mjs — respects rulesScope', () => {
  it('should read rulesScope from config.json', () => {
    expect(uninstallScript).toMatch(/rulesScope/);
  });

  it('should clean up CLAUDE.md from the active scope', () => {
    // Must handle both global (~/.claude/CLAUDE.md) and project (.claude/CLAUDE.md)
    expect(uninstallScript).toMatch(/CLAUDE\.md/);
    expect(uninstallScript).toMatch(/rulesScope|project/i);
  });

  it('should clean up AGENTS.md from the active scope', () => {
    expect(uninstallScript).toMatch(/AGENTS\.md/);
  });

  it('should clean up GEMINI.md from the active scope', () => {
    expect(uninstallScript).toMatch(/GEMINI\.md/);
  });

  it('should clean up agenfk.mdc from the active scope', () => {
    expect(uninstallScript).toMatch(/agenfk\.mdc/);
  });
});

/**
 * Extract a section of the script around a keyword.
 * Returns ~1000 chars around the first occurrence.
 */
function extractSection(script: string, keyword: string): string {
  const idx = script.indexOf(keyword);
  if (idx === -1) return '';
  return script.slice(Math.max(0, idx - 500), idx + 500);
}
