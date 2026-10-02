import { existsSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { HOOK_VARIANTS } from './uninstall-helpers.mjs';

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

// --- Windows hook commands under Git Bash (issue #192) ---------------------
//
// Claude Code hands a hook `command` to `bash -c` (Git Bash on Windows). An
// unquoted `C:\Users\x\.local\bin\agenfk-*.cmd` loses every backslash to bash's
// escape handling and fails "command not found" -- non-blocking, so the guard is
// silently skipped. The command must be a quoted, forward-slash path to the
// extensionless `#!/bin/sh` wrapper (a `.cmd` cannot be run by bash anyway).

// Forward-slash form of a path; safe inside bash and accepted by Windows APIs.
export function toBashPath(p) {
  return String(p).replace(/\\/g, '/');
}

// The hook `command` string to register for Claude Code. `destBase` is the
// extensionless path (e.g. ~/.local/bin/agenfk-mcp-enforcer); `args` is appended
// outside the quotes. Off Windows the plain path is kept as-is.
export function buildClaudeHookCommand(destBase, { platform = process.platform, args = '' } = {}) {
  const suffix = args ? ` ${args}` : '';
  if (platform === 'win32') return `"${toBashPath(destBase)}"${suffix}`;
  return `${destBase}${suffix}`;
}

// Body of the extensionless POSIX wrapper that forwards to a hook's .mjs. The
// .mjs path uses forward slashes so no backslash survives anywhere in the chain.
export function buildPosixWrapper(mjsPath) {
  return `#!/bin/sh\nexec node "${toBashPath(mjsPath)}" "$@"\n`;
}

// Every Claude Code hook command the installer registers, keyed by hook name.
// Deriving the keys from HOOK_VARIANTS is the point: agenfk-run-hook (CGLAB-177)
// was added after #192 was fixed and registered as a bare `.cmd` path, which Git
// Bash cannot run. A hook added to HOOK_VARIANTS now gets the same command shape
// or fails the test for this table.
const CLAUDE_HOOK_ARGS = {
  'agenfk-pr-hook': '--client claude-code',
  'agenfk-run-hook': '--client claude-code',
};

export function claudeHookCommands(localBinDir, { platform = process.platform } = {}) {
  const join = (name) => (platform === 'win32' ? path.win32 : path.posix).join(localBinDir, name);
  return Object.fromEntries(HOOK_VARIANTS.map((name) => [
    name,
    buildClaudeHookCommand(join(name), { platform, args: CLAUDE_HOOK_ARGS[name] ?? '' }),
  ]));
}

// Merge the agenfk hooks into a Claude Code settings object. Pure, so the win32
// command shape can be tested on any OS: the installer only ever runs on the
// host platform, and on POSIX a hand-built command and the table's are the same
// string. Existing agenfk entries are replaced, never duplicated, so an upgrade
// over the old bare `.cmd` registrations leaves one of each.
export function applyClaudeHooks(settings, localBinDir, { platform = process.platform } = {}) {
  const claudeHookCmd = claudeHookCommands(localBinDir, { platform });
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
      !JSON.stringify(entry).includes('agenfk-gatekeeper') &&
      !JSON.stringify(entry).includes('agenfk-mcp-enforcer')
  );

  settings.hooks.PreToolUse.push({
      matcher: 'Edit|Write|NotebookEdit',
      hooks: [{ type: 'command', command: claudeHookCmd['agenfk-gatekeeper'] }]
  });

  settings.hooks.PreToolUse.push({
      matcher: 'Bash|Read',
      hooks: [{ type: 'command', command: claudeHookCmd['agenfk-mcp-enforcer'] }]
  });

  // PostToolUse hook for PR sizing (fires on Bash so it can react to
  // `gh pr create` and `git push`).
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
      !JSON.stringify(entry).includes('agenfk-pr-hook') &&
      !JSON.stringify(entry).includes('agenfk-run-hook')
  );
  settings.hooks.PostToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: claudeHookCmd['agenfk-pr-hook'] }]
  });
  // Records tool calls as agent-run events (CGLAB-177). Matches the tools
  // worth a transcript line; the hook itself filters further and never
  // blocks, so a slow or absent server costs nothing.
  settings.hooks.PostToolUse.push({
      matcher: 'Bash|Edit|Write|NotebookEdit|Task|WebFetch',
      hooks: [{ type: 'command', command: claudeHookCmd['agenfk-run-hook'] }]
  });
  // Closes the run when the session ends. Without this every run the
  // hook opens stays `running` with no endedAt forever — the sessions
  // rail shows work that finished weeks ago as still in flight, and the
  // states that need a run to reach an outcome are unreachable.
  //
  // SessionEnd, NOT Stop. `Stop` is a per-TURN hook — it fires each time
  // the assistant finishes answering, and can block "the turn from
  // ending" — so registering it there closed the run after the first
  // turn of a live session and, because closing drops the cache entry,
  // made the next tool call open a brand new run. One session became
  // dozens. See `closesRun` in bin/agenfk-run-hook.mjs.
  settings.hooks.SessionEnd = (settings.hooks.SessionEnd ?? []).filter(
      entry => !JSON.stringify(entry).includes('agenfk-run-hook'),
  );
  settings.hooks.SessionEnd.push({
      // An explicit timeout, and it is NOT belt-and-braces. SessionEnd
      // hooks are given a far tighter budget than every other event —
      // 1.5 seconds against ten minutes — and the per-hook `timeout`
      // field (in seconds) is the only way to raise it. Without this the
      // close has to finish node startup and a PATCH inside 1.5s, and a
      // slow local server eats the whole budget silently, which is the
      // exact failure closing on SessionEnd was meant to fix.
      hooks: [{ type: 'command', command: claudeHookCmd['agenfk-run-hook'], timeout: 10 }]
  });
  // Remove the old registration from anyone who installed before the fix,
  // or the per-turn close keeps happening beside the correct one.
  if (settings.hooks.Stop) {
      settings.hooks.Stop = settings.hooks.Stop.filter(
          entry => !JSON.stringify(entry).includes('agenfk-run-hook'),
      );
      if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  }
  return settings;
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

// Commands that cut releases of the AgEnFK framework itself. They live in the
// repo's own .claude/commands/ and must NEVER reach a user's global config.
const REPO_PRIVATE_NAMES = ['agenfk-release', 'agenfk-release-beta', 'agenfk-release-hub'];

// True for a repo-private release command in either shape a copy step sees it:
// `agenfk-release.md` (a flat command) or `agenfk-release/` (a skill dir).
//
// Applied at COPY sites only, deliberately NOT folded into
// isInstallableMarkdown: removal steps (uninstall, removeCommandsFromDir) filter
// with that predicate to decide what to DELETE, and excluding these names there
// would leave a leaked copy behind forever instead of cleaning it up.
//
// Mirrored in packages/cli/src/index.ts, which cannot import from scripts/.
export function isRepoPrivateCommand(name) {
  if (typeof name !== 'string') return false;
  const base = shadowedName(name).replace(/\.md$/, '');
  return REPO_PRIVATE_NAMES.includes(base);
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

/**
 * Are these the same directory on disk? By (dev, inode), not by spelling: a
 * symlinked ~/.agenfk-system, or a path cased differently on APFS, is still
 * that directory (Codex review of 658ef023). False when either is missing.
 */
export function sameDirectory(a, b) {
  try {
    // BigInt: as plain numbers, distinct 64-bit inodes can round to one value
    // (2^53 and 2^53+1 do). And an inode of 0 is no identity at all - some
    // filesystems report it - so it never proves two paths the same: when in
    // doubt, the tree is treated as a checkout and left alone.
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    if (!x.ino || !y.ino) return false;
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * A developer's working tree, not an installed copy (658ef023): it holds .git
 * (a directory, or the file a worktree or submodule has). Except
 * ~/.agenfk-system, which IS a clone in real installs - packages/create's
 * --rebuild and download-failure fallbacks clone into it.
 *
 * Mirrored in packages/cli/src/index.ts and packages/server/src/hub/upgradeSync.ts,
 * which cannot import from scripts/.
 */
export function isDevCheckout(root, home = os.homedir()) {
  if (!existsSync(path.join(root, '.git'))) return false;
  return !sameDirectory(root, path.join(home, '.agenfk-system'));
}

