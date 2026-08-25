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

// --- macOS metadata guards (CGLAB-94 / issue #163) -------------------------
//
// Releases packaged on macOS shipped an AppleDouble `._<name>` twin for every
// file carrying an extended attribute, and the sync steps installed the ones
// named `._agenfk*.md` into every platform's skills/commands dir. Uninstall
// used to miss them entirely: its filters match names that START WITH
// "agenfk", and "._agenfk" does not — so removing agenfk left the garbage
// skills behind, still polluting every agent session.
//
// Scope matters here. These directories are SHARED with other tools, so we may
// only claim our own litter: an AppleDouble twin is named after the file it
// shadows, so ours are exactly `._agenfk*`. A bare `._*` test would also delete
// another tool's twin and any `.DS_Store` — files whose data we do not own.

// True for macOS resource-fork / Finder metadata of any origin.
export function isMacMetadata(name) {
  return typeof name === 'string' && (name.startsWith('._') || name === '.DS_Store');
}

// The name an AppleDouble twin shadows: `._agenfk.md` -> `agenfk.md`.
function shadowedName(name) {
  return name.startsWith('._') ? name.slice(2) : name;
}

// True for an entry uninstall should remove from a SHARED skills/commands dir:
// one of ours, or the AppleDouble twin of one of ours. Never a third party's.
export function isAgenfkOwnedEntry(name) {
  return typeof name === 'string' && shadowedName(name).startsWith('agenfk');
}

// Same, restricted to a given extension (flat command files). The extension is
// checked on the shadowed name, so `._agenfk.json` is not swept by a `.md` site.
export function isAgenfkOwnedFile(name, ext) {
  if (typeof name !== 'string') return false;
  const shadowed = shadowedName(name);
  return shadowed.startsWith('agenfk') && shadowed.endsWith(ext);
}

// True for a macOS metadata artifact that shadows one of OUR files. Commands
// dirs can hold AppleDouble *directories* (`._agenfk-calc-tokens/`, the twin of
// a skill dir), which carry no extension and so are not matched by
// isAgenfkOwnedFile — they still have to go.
export function isAgenfkOwnedArtifact(name) {
  return isMacMetadata(name) && isAgenfkOwnedEntry(name);
}
