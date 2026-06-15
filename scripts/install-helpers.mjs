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
