// Pure, side-effect-free helpers extracted from install.mjs / bin/agenfk.js so the
// install-flow decision logic can be unit-tested as real behavior (issue #86).

export const RULES_SCOPES = ['global', 'project'];

// Normalize a raw scope value to 'global' | 'project', or null if absent/invalid.
export function normalizeScope(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return RULES_SCOPES.includes(v) ? v : null;
}

// Decide the rules scope without ever blocking on a prompt when stdin is non-interactive.
// Precedence: explicit flag → env var → existing config → (TTY ? prompt-with-default : default).
// Returns { scope: 'global'|'project', shouldPrompt: boolean }.
//
// The bug (issue #86): the installer unconditionally created a readline prompt. Under npx /
// piped stdin (no TTY) the prompt got an immediate EOF, the promise never resolved, Node
// exited 0, and the rest of the install (incl. the CLI symlink) was silently skipped.
export function resolveRulesScope({ rulesScopeArg, envScope, existingScope, isTTY } = {}) {
  const fromArg = normalizeScope(rulesScopeArg);
  if (fromArg) return { scope: fromArg, shouldPrompt: false };

  const fromEnv = normalizeScope(envScope);
  if (fromEnv) return { scope: fromEnv, shouldPrompt: false };

  const fromConfig = normalizeScope(existingScope);
  if (fromConfig) return { scope: fromConfig, shouldPrompt: false };

  // Nothing preset: prompt only when we can actually read a reply.
  // The default in both cases is 'global' (used directly when non-interactive,
  // and as the default answer when interactive).
  return { scope: 'global', shouldPrompt: Boolean(isTTY) };
}

// Build a valid Codex CLI hooks.json config that registers the AgEnFK PR-sizing
// hook (CGLAB-12). Codex rejects a Claude-Code-style top-level `PostToolUse` key
// ("unknown field `PostToolUse`, expected `description` or `hooks`") and refuses
// to start — the installer used to write exactly that. Codex requires hook events
// nested under a top-level `hooks` object, and it matches the shell tool as `Bash`
// (not `shell`), so the old matcher never fired either.
//
// This is a pure merge over whatever is already on disk:
//   - Any legacy top-level `PostToolUse` (only our old, broken installer ever wrote
//     it) is migrated into `hooks.PostToolUse` and the top-level key removed, so an
//     upgrade self-heals the crash. Unrelated legacy entries are preserved, not dropped.
//   - A prior AgEnFK entry is replaced (idempotent — no duplication on re-install).
//   - Unrelated user entries, other events, and `description` are left intact.
export function buildCodexHooksConfig(existingConfig, prHookCommand) {
  const src = (existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig))
    ? existingConfig
    : {};
  const config = { ...src };

  // Legacy top-level PostToolUse: invalid Codex schema. Salvage its entries, drop the key.
  const legacy = Array.isArray(config.PostToolUse) ? config.PostToolUse : [];
  delete config.PostToolUse;

  const hooks = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks))
    ? { ...config.hooks }
    : {};
  const nested = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];

  // Drop any prior AgEnFK entry (from either location) so re-install is idempotent.
  const preserved = [...legacy, ...nested].filter((e) => !JSON.stringify(e).includes('agenfk-pr-hook'));
  preserved.push({ matcher: 'Bash', hooks: [{ type: 'command', command: prHookCommand }] });

  hooks.PostToolUse = preserved;
  config.hooks = hooks;
  return config;
}

// Decide whether to register the agenfk MCP server with Codex (CGLAB-15).
//
// Codex runs tools in a sandbox that often blocks outbound localhost, so the
// agenfk CLI cannot reach the local API server there. The MCP stdio server is not
// subject to that restriction, so — unlike every other client, which stays
// CLI-only unless --with-mcp — Codex gets MCP registered BY DEFAULT, overriding
// AgEnFK's global CLI-only default.
//
// Precedence (highest first):
//   --no-mcp            → false (explicit opt-out this run; persisted so it sticks)
//   --with-mcp          → true  (explicit opt-in re-enables a prior opt-out)
//   persistedCodexMcp   → a prior decision (so an opt-out survives flag-less upgrades)
//   otherwise           → true  (default on for Codex)
//
// persistedCodexMcp is `config.codexMcp` from ~/.agenfk/config.json; without it an
// opt-out would silently un-stick on the next flag-less `agenfk upgrade`.
/**
 * @param {{ noMcp?: boolean, withMcp?: boolean, persistedCodexMcp?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldRegisterCodexMcp({ noMcp = false, withMcp = false, persistedCodexMcp } = {}) {
  if (noMcp) return false;
  if (withMcp) return true;
  if (persistedCodexMcp === false) return false;
  return true;
}

// Return the "source <rc>" hint string, or null when no rc file was modified (#4).
// Showing the hint when nothing was changed is misleading — the export was correctly
// skipped because ~/.local/bin was already on PATH.
export function shellSourceHint({ rcModified, shell } = {}) {
  if (!rcModified) return null;
  switch (shell) {
    case 'zsh': return 'source ~/.zshrc';
    case 'bash': return 'source ~/.bashrc';
    case 'fish': return 'source ~/.config/fish/config.fish';
    default: return 'source your shell rc file';
  }
}

// --- macOS metadata guards (CGLAB-94 / issue #163) -------------------------
//
// Releases cut on macOS shipped an AppleDouble `._<name>` companion for every
// file carrying an extended attribute. Those entries look like ordinary files
// to every consumer: `._agenfk.md` satisfies an `endsWith('.md')` filter, so
// the skills/commands sync copied them into ~/.claude/skills et al, where each
// `._agenfk-*` directory was surfaced as a skill whose description is mojibake
// binary — injected into the system prompt of every agent session.
//
// Packaging is fixed at the source (scripts/package-helpers.mjs), but these
// guards must stay: a user upgrading from a polluted release still has the
// artifacts on disk, and the installer must neither propagate nor preserve them.

// True for macOS resource-fork / Finder metadata: never install it, and sweep it
// when a previous (polluted) release left it in a skills/commands dir.
// Deliberately matches any `._*` entry, not just `._agenfk*` — the AppleDouble
// twin of a real agenfk skill is named after the skill.
export function isMacMetadata(name) {
  return typeof name === 'string' && (name.startsWith('._') || name === '.DS_Store');
}

// Filter for source files a sync step may install: real payload only.
export function isInstallableMarkdown(name) {
  return typeof name === 'string' && name.endsWith('.md') && !isMacMetadata(name);
}

// The name an AppleDouble twin shadows: `._agenfk.md` -> `agenfk.md`.
function shadowedName(name) {
  return name.startsWith('._') ? name.slice(2) : name;
}

// True for an entry we own in a SHARED skills/commands dir: one of ours, or the
// AppleDouble twin of one of ours. Deliberately mirrored in uninstall-helpers.mjs
// rather than imported: the uninstaller must keep working on a partial install
// where this module may be missing, which is exactly when it gets run.
export function isAgenfkOwnedEntry(name) {
  return typeof name === 'string' && shadowedName(name).startsWith('agenfk');
}
