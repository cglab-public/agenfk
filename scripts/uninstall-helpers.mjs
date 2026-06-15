// Pure, side-effect-free helpers extracted from uninstall.mjs so the removal
// decision logic can be unit-tested as real behavior (issue #88).
//
// The bugs these guard against:
//   #2 the uninstaller removed only the `agenfk-gatekeeper` hook variant, leaving
//      `agenfk-mcp-enforcer` and `agenfk-pr-hook` bins + settings entries behind.
//   #4 a partial uninstall was silent — no per-step result tracking, no summary.
//   #5 without `-y`, the destructive run "assumed yes" instead of prompting/aborting.

// Every hook variant the installer writes. Used both for bin removal and for
// filtering hook entries out of every client's settings/hooks file.
export const HOOK_VARIANTS = ['agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook'];

// Bin filenames the installer drops into ~/.local/bin. The `agenfk` CLI symlink
// plus all three hook variants. On Windows each is a `.cmd` shim.
export function hookBinFilenames(platform) {
  const suffix = platform === 'win32' ? '.cmd' : '';
  return ['agenfk', ...HOOK_VARIANTS].map((n) => `${n}${suffix}`);
}

// Opencode plugin filenames the installer copies into ~/.config/opencode/plugins.
export function opencodePluginFilenames() {
  return HOOK_VARIANTS.map((n) => `${n}.mjs`);
}

// True if a single hook entry (from any client's hook array) references an AgenFK
// hook script. JSON.stringify mirrors how the installer itself matches entries.
export function isAgenfkHookEntry(entry) {
  const json = JSON.stringify(entry);
  return HOOK_VARIANTS.some((marker) => json.includes(marker));
}

// Remove every AgenFK hook entry from a client hook array, returning a new array.
// Non-AgenFK entries are preserved untouched. Accepts non-arrays defensively.
export function stripAgenfkHookEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.filter((e) => !isAgenfkHookEntry(e));
}

// Decide whether a destructive uninstall may proceed, and whether to prompt first.
// Precedence: explicit -y/--yes → proceed without prompt; else interactive TTY →
// prompt; else (non-interactive, no flag) → abort rather than assuming consent (#5).
// Returns { proceed, shouldPrompt }.
export function resolveConfirmation({ skipConfirm, isTTY } = {}) {
  if (skipConfirm) return { proceed: true, shouldPrompt: false };
  if (isTTY) return { proceed: false, shouldPrompt: true };
  return { proceed: false, shouldPrompt: false };
}

// Aggregate per-step results into a summary (#4). `results` is an array of
// { label, status: 'removed' | 'skipped' | 'failed', error? }. exitCode is non-zero
// when any step failed so a partial uninstall surfaces in CI / scripts.
export function summarizeResults(results = []) {
  const removed = results.filter((r) => r.status === 'removed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed');
  return {
    removed,
    skipped,
    failed: failed.length,
    failures: failed,
    exitCode: failed.length > 0 ? 1 : 0,
  };
}
