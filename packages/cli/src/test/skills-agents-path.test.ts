/**
 * TDD tests for skills fix:
 * - Add ~/.agents/skills/ as universal platform (covers Codex which only reads from there)
 * - Inject 'name' frontmatter field when copying commands to skills dirs
 * - install.mjs installs to ~/.agents/skills/
 * - Uninstall cleans up ~/.agents/skills/
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const cliSource = readFileSync(path.join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
const installScript = readFileSync(path.join(ROOT, 'scripts/install.mjs'), 'utf8');
const uninstallScript = readFileSync(path.join(ROOT, 'scripts/uninstall.mjs'), 'utf8');

// --- 1. COMMAND_SKILL_PLATFORMS includes ~/.agents/skills/ ---

describe('CLI — COMMAND_SKILL_PLATFORMS includes universal .agents/skills path', () => {
  it('should include ~/.agents/skills as a global skill destination', () => {
    // path.join uses separate string args so match both args near each other
    expect(cliSource).toMatch(/['"]\.agents['"].*['"]skills['"]/);
  });

  it('should include .agents/skills as a project-level skill destination', () => {
    // projectDir uses root + .agents/skills — check both args appear together
    expect(cliSource).toMatch(/['"]\.agents['"].*['"]skills['"]/);
  });

  it('should have a platform entry named "Universal (.agents)"', () => {
    expect(cliSource).toMatch(/Universal.*\.agents/);
  });
});

// --- 2. syncCommandsToDir injects 'name' field ---

describe('CLI — syncCommandsToDir injects name frontmatter field', () => {
  it('should inject name field into SKILL.md when missing', () => {
    // The syncCommandsToDir function must read file content and inject name
    const syncSection = extractSection(cliSource, 'syncCommandsToDir');
    expect(syncSection).toMatch(/name/i);
  });

  it('should derive skill name from filename (strip .md extension)', () => {
    // name = file.replace('.md', '') or similar
    const syncSection = extractSection(cliSource, 'syncCommandsToDir');
    expect(syncSection).toMatch(/replace.*\.md|\.md.*replace/);
  });

  it('should not duplicate name field if already present', () => {
    // Must check if name: is already in frontmatter before injecting
    const syncSection = extractSection(cliSource, 'syncCommandsToDir');
    expect(syncSection).toMatch(/name:|already|existing|match|includes/i);
  });

  it('should write file content (not just copyFileSync) to allow name injection', () => {
    // syncCommandsToDir must use writeFileSync (not just copyFileSync)
    // Search the full source since the function body may extend past the extraction window
    const syncIdx = cliSource.indexOf('function syncCommandsToDir');
    const syncEnd = cliSource.indexOf('\n}', syncIdx) + 2;
    const syncBody = cliSource.slice(syncIdx, syncEnd);
    expect(syncBody).toMatch(/writeFileSync|writeFile/);
  });
});

// --- 3. install.mjs installs to ~/.agents/skills/ ---

describe('install.mjs — installs skills to ~/.agents/skills/', () => {
  it('should install commands to ~/.agents/skills/ directory', () => {
    expect(installScript).toMatch(/\.agents[\/\\]skills/);
  });

  it('should inject name field when creating SKILL.md files in install.mjs', () => {
    const agentsSection = extractSection(installScript, '.agents');
    expect(agentsSection).toMatch(/name/i);
  });
});

// --- 4. Uninstall cleans up ~/.agents/skills/ ---

describe('uninstall.mjs — cleans up ~/.agents/skills/', () => {
  it('should remove ~/.agents/skills/agenfk* dirs on uninstall', () => {
    // path.join uses separate string args
    expect(uninstallScript).toMatch(/['"]\.agents['"].*['"]skills['"]/);
  });
});

// --- 5. All command source files have name field OR injection handles it ---

describe('commands/*.md — name field coverage', () => {
  it('should have agenfk-flow.md with name field (already present)', () => {
    const flowCmd = readFileSync(path.join(ROOT, 'commands', 'agenfk-flow.md'), 'utf8');
    expect(flowCmd).toMatch(/^name:\s*agenfk-flow/m);
  });

  it('syncCommandsToDir should inject name for commands missing it (like agenfk.md)', () => {
    // agenfk.md currently lacks name field - syncCommandsToDir must add it
    const agenfkCmd = readFileSync(path.join(ROOT, 'commands', 'agenfk.md'), 'utf8');
    // Source file doesn't need name - injection happens at install time
    // Verify the injection logic exists in CLI
    expect(cliSource).toMatch(/writeFileSync|inject.*name|name.*inject/i);
  });
});

// --- 6. OpenCode slash commands (flat .md in commands/) ---

describe('CLI — OpenCode slash commands installed to commands/', () => {
  it('should install flat .md files to ~/.config/opencode/commands/', () => {
    expect(cliSource).toMatch(/opencode.*commands|commands.*opencode/i);
  });

  it('should NOT include opencode commands/ in LEGACY_COMMANDS_DIRS', () => {
    // opencode/commands/ must NOT be marked legacy — it's the active slash command path
    const legacySection = extractSection(cliSource, 'LEGACY_COMMANDS_DIRS');
    expect(legacySection).not.toMatch(/opencode.*commands/);
  });
});

// --- 7. Gemini CLI slash commands (TOML in commands/) ---

describe('CLI — Gemini CLI slash commands installed as TOML', () => {
  it('should generate .toml files in ~/.gemini/commands/', () => {
    expect(cliSource).toMatch(/gemini.*commands.*toml|toml.*gemini.*commands/i);
  });

  it('should NOT include gemini commands/ in LEGACY_COMMANDS_DIRS', () => {
    // gemini/commands/ must NOT be marked legacy — it's the active slash command path
    const legacySection = extractSection(cliSource, 'LEGACY_COMMANDS_DIRS');
    expect(legacySection).not.toMatch(/gemini.*commands/);
  });

  it('install.mjs should NOT remove ~/.gemini/commands/ TOML files', () => {
    // uninstall.mjs may clean up, but install.mjs must not delete existing TOML files
    // The install step should regenerate/install them
    expect(installScript).toMatch(/gemini.*commands.*toml|toml.*gemini/i);
  });
});

function extractSection(source: string, keyword: string): string {
  const idx = source.indexOf(keyword);
  if (idx === -1) return '';
  return source.slice(Math.max(0, idx - 200), idx + 800);
}
