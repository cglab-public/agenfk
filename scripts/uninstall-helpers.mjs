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
export const HOOK_VARIANTS = ['agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook', 'agenfk-run-hook'];

// Bin filenames the installer drops into ~/.local/bin. The `agenfk` CLI symlink
// plus all three hook variants. On Windows each is a `.cmd` shim, and each also
// has an extensionless `#!/bin/sh` wrapper: the hooks' is what Claude Code's Git
// Bash hook command points at (issue #192), the CLI's is what Git Bash runs as
// `agenfk` (install.mjs writes it under MinGW; #215 - it used to be left behind).
export function hookBinFilenames(platform) {
  if (platform === 'win32') {
    return [
      ...['agenfk', ...HOOK_VARIANTS].map((n) => `${n}.cmd`),
      'agenfk',
      ...HOOK_VARIANTS,
    ];
  }
  return ['agenfk', ...HOOK_VARIANTS];
}

// What a default uninstall removes from ~/.agenfk (#214). Everything else in
// that directory is the user's data — the database, backup/, hub.json (hub
// enrolment), installation-id, config.json (which carries dbPath, so a
// reinstall finds the board again), the hub deadletter, stored tokens — and
// is kept unless --purge-data is passed. Listing what goes rather than what
// stays is deliberate: a state file added later is kept by default instead of
// silently deleted.
export const AGENFK_HOME_RUNTIME_ENTRIES = [
  'verify-token',
  'server-port',
  'active-work',
  'active-work.json',
  'claude-runs.json',
  'upgrade-tier-cache.json',
  'bin',
  // The release commands' gatekeeper bypass: honoured for five minutes, so a
  // quick reinstall would otherwise come back with enforcement off.
  'skip-gatekeeper',
];

// True for an entry of ~/.agenfk that a default uninstall removes: the list
// above, plus the run hook's write-then-rename temp file (claude-runs.json.<pid>)
// that an interrupted hook leaves behind.
export function isAgenfkHomeRuntimeEntry(name) {
  return AGENFK_HOME_RUNTIME_ENTRIES.includes(name) || /^claude-runs\.json\.\d+$/.test(name);
}

// The first path segment of `target` below `root`, or null when `target` is
// not inside `root`. Used to keep the ~/.agenfk-system entry that holds the
// board database when the rest of that directory is removed.
export function topLevelEntryWithin(root, target, pathMod) {
  const rel = pathMod.relative(root, target);
  // `..` exactly or `..<sep>…` is outside; a name like `..boards` is inside.
  if (!rel || rel === '..' || rel.startsWith(`..${pathMod.sep}`) || pathMod.isAbsolute(rel)) return null;
  return rel.split(pathMod.sep)[0];
}

// The directory under ~/.agenfk-system that holds the board database on a
// default npx install (install.mjs: dbPath = <rootDir>/.agenfk/db.sqlite).
// A default uninstall removes the framework around it and keeps it.
export const SYSTEM_DIR_DATA_ENTRY = '.agenfk';

// The Windows extensionless `agenfk` is ours only when it is the wrapper
// install.mjs writes under MinGW: `#!/bin/sh` then `node "<...>/agenfk.js" "$@"`.
// A non-MinGW install never writes one, so a file of that name there may be the
// user's own and is left alone (#215 review).
export function isAgenfkCliWrapper(content) {
  return /^#!\/bin\/sh\r?\nnode "[^"]*agenfk\.js" "\$@"\s*$/.test(String(content));
}

// Not every hook has an Opencode plugin. The installer copies one only where a
// `bin/<name>-opencode.mjs` source exists, and agenfk-run-hook has none — it is
// a Claude Code PostToolUse hook. Deriving this list from HOOK_VARIANTS made the
// uninstaller claim a plugin that is never written; harmless at runtime, because
// removal is a no-op, but it is an assertion about the installed state and it
// was false. The test cross-checks this against bin/*-opencode.mjs, so adding a
// plugin without adding it here fails rather than silently leaking on uninstall.
export const OPENCODE_PLUGIN_VARIANTS = [
  'agenfk-gatekeeper',
  'agenfk-mcp-enforcer',
  'agenfk-pr-hook',
  'agenfk-airlock',
];

// Opencode plugin filenames the installer copies into ~/.config/opencode/plugins.
export function opencodePluginFilenames() {
  return OPENCODE_PLUGIN_VARIANTS.map((n) => `${n}.mjs`);
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
