#!/usr/bin/env node
/**
 * AgEnFK PR sizing hook — fires on PostToolUse / tool.execute.after for shell
 * commands. Detects `gh pr create` (open trigger) or `git push` to a branch
 * with a registered PR (push trigger), then emits a directive back to the
 * agent telling it to call register_pr(...) or update_pr_sizing(...).
 *
 * The hook NEVER writes to the database itself — it only nudges the agent,
 * because the agent has the semantic knowledge (which items are bundled into
 * this PR) that a server-side walk doesn't.
 *
 * Usage in client config: `agenfk-pr-hook --client <name>`
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Pure helpers (also exported for unit tests) ──────────────────────────────

/**
 * Split a shell command into simple-command segments on unquoted separators
 * (&&, ||, ;, |, & and newlines). A heuristic, not a full shell parser — but
 * quote-aware, so `git commit -m "a && gh pr create"` yields ONE segment and
 * the words inside the quotes can't trigger anything.
 */
export function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null; // active quote char (' or ") or null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      // Shell semantics: NO escapes inside single quotes — a lone ' always closes.
      // (This is what makes the common 'it'\''s done' idiom parse correctly.)
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) { current += ch + command[i + 1]; i++; continue; }
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    // Unquoted: backslash escapes the next char (so \' doesn't open a quote).
    if (ch === '\\' && i + 1 < command.length) { current += ch + command[i + 1]; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '<' && command[i + 1] === '<') {
      // Heredoc: we don't parse heredoc bodies — swallow the remainder into
      // this segment so body lines can't masquerade as commands. (A chained
      // command AFTER the heredoc is missed: false negatives beat body lines
      // triggering false nudges.)
      current += command.slice(i);
      break;
    }
    if (ch === '\n' || ch === ';') { segments.push(current); current = ''; continue; }
    if (ch === '&' || ch === '|') {
      // `>&` (2>&1) and `&>` are redirections, not separators.
      if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) { current += ch; continue; }
      // `&&` / `||` / `|` / trailing `&` all end the segment; skip the doubled char.
      if (command[i + 1] === ch) i++;
      segments.push(current); current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map(s => s.trim()).filter(Boolean);
}

/** Strip leading NAME=value environment assignments (values may be quoted). */
export function stripEnvAssignments(segment) {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, '');
}

/**
 * The destination branch of a push refspec.
 *
 * `HEAD:feat/x` pushed to feat/x, not to a branch called 'HEAD:feat/x' — the
 * old classifier handed the whole refspec back, so the nudge read
 * "you just pushed to 'HEAD:staging'" (BUG 40ff964b). A git ref cannot contain
 * ':', so cutting at the LAST colon is unambiguous; `:feat/x` (a delete) has an
 * empty source and still names feat/x.
 */
export function normalizePushRef(ref) {
  if (!ref) return undefined;
  let branch = ref;
  const colon = branch.lastIndexOf(':');
  if (colon !== -1) branch = branch.slice(colon + 1);
  branch = branch.replace(/^\+/, '');
  branch = branch.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');
  return branch || undefined;
}

/** Strip one layer of matching shell quotes, if present. */
function unquote(token) {
  if (typeof token !== 'string' || token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1);
  return token;
}

/**
 * Is this a directory the shell would read as absolute, or as something the
 * hook must leave for the runtime to resolve (`~user`, `$VAR`)?
 */
function isShellAbsolute(dir) {
  return dir.startsWith('/') || dir.startsWith('~') || dir.startsWith('$') || /^[A-Za-z]:[\\/]/.test(dir);
}

/**
 * Join a relative `cd` onto the previous one.
 *
 * `cd /repo && cd wt1 && git push` pushes in `/repo/wt1`. Carrying `wt1`
 * verbatim and resolving it against the hook's cwd read a decoy repo (review
 * finding), which is the original defect wearing a different hat.
 */
function joinShellDir(base, next) {
  return base.endsWith('/') ? base + next : `${base}/${next}`;
}

/**
 * Read `git <global options> push <args>` back as `{ cwd, args }`, or null when
 * this is not a push.
 *
 * A second reason to look past `push` (BUG 40ff964b): the old anchor was
 * `^git\s+push`, so `git -C <repo> push` never matched at all and those pushes
 * got no nudge. `-C` is also a directory, and the repo it points at is the one
 * whose branch the push reports.
 */
export function splitGitPush(rest) {
  let cwd;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '-C') {
      const value = rest[i + 1];
      if (value) { cwd = unquote(value); i++; continue; }
    } else if (tok.startsWith('-C') && tok.length > 2) {
      cwd = unquote(tok.slice(2));
      continue;
    } else if (tok === '-c' || tok === '--git-dir' || tok === '--work-tree' || tok === '--namespace') {
      i++; // option with a separate value
      continue;
    }
    if (tok === 'push') return { cwd, args: rest.slice(i + 1) };
    // Any other non-option token before `push` means this is not a push.
    if (!tok.startsWith('-')) return null;
  }
  return null;
}

export function classifyTrigger(command) {
  if (typeof command !== 'string') return null;
  // Segment-aware (CGLAB-11): the old ^-anchored match on the whole command
  // missed `cd x && gh pr create` and `GH_TOKEN=x gh pr create`, so those PRs
  // never got the register nudge. An `open` anywhere in the chain wins over a
  // `push` (the same chain often pushes then opens).
  let push = null;
  // The directory the command moves into. A push that runs in another repo has
  // to be reported by THAT repo's branch (BUG 40ff964b); without this, the
  // runtime fell back to the hook's own cwd and named the session repo's branch
  // - typically 'main' while the push went to a feature branch in a worktree.
  let cwd;
  for (const rawSegment of splitShellSegments(command)) {
    const segment = stripEnvAssignments(rawSegment);
    if (/^gh\s+pr\s+create\b/.test(segment)) return { kind: 'open' };
    // `cd <dir>` is the whole segment; the last one before the push wins, and a
    // relative target is relative to the PREVIOUS one, not to the hook's cwd.
    const cdMatch = segment.match(/^cd\s+(?:--\s+)?("[^"]*"|'[^']*'|\S+)\s*$/);
    if (cdMatch) {
      const next = unquote(cdMatch[1]);
      cwd = cwd && !isShellAbsolute(next) ? joinShellDir(cwd, next) : next;
      continue;
    }
    const gitMatch = segment.match(/^git\b(.*)$/);
    if (gitMatch && !push) {
      const parsed = splitGitPush((gitMatch[1] || '').trim().split(/\s+/).filter(Boolean));
      if (!parsed) continue;
      // `-C` is a directory too, and it overrides an earlier cd.
      const targetCwd = parsed.cwd ?? cwd;
      let rest = parsed.args;
      // Everything from the first redirection onwards is shell plumbing, not
      // arguments to git. Cutting there — rather than filtering tokens that
      // CONTAIN < or > — is what handles a target written as its own token:
      // `git push -u origin feat/x > out.txt` used to report the branch as
      // 'out.txt', and `2> /dev/null` as '/dev/null'. (Pipes and && are already
      // gone by here; splitShellSegments ended the segment at them.)
      // The optional prefix covers every spelling that can precede the
      // operator: a plain `>file`, a numbered `2>file`, bash's `&>file`, and a
      // named descriptor `{fd}>file`. Anchoring on digits alone let `&>` and
      // `{fd}>` through — which the old per-token filter had caught, so
      // narrowing to a cut REGRESSED them.
      const redirect = rest.findIndex(tok => /^(?:\d+|&|\{\w+\})?[<>]/.test(tok));
      if (redirect !== -1) rest = rest.slice(0, redirect);
      // Last non-flag token, ignoring the remote name.
      let branch;
      for (let i = rest.length - 1; i >= 0; i--) {
        const tok = rest[i];
        if (!tok || tok.startsWith('-')) continue;
        if (tok === 'origin') continue;
        // Belt to the cut's braces. A ref can never contain < or > — git
        // refuses them — so anything that does is plumbing the cut missed,
        // and keeping this costs nothing. Dropping it is what let &> regress.
        if (/[<>]/.test(tok)) continue;
        branch = tok;
        break;
      }
      push = { kind: 'push', branch: normalizePushRef(branch) };
      if (targetCwd) push.cwd = targetCwd;
    }
  }
  return push;
}

export function buildDirective(client, message) {
  switch (client) {
    case 'claude-code':
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
    case 'codex':
      // CGLAB-86: the old { decision: 'continue', reason } envelope was REJECTED
      // by Codex with "hook returned invalid post-tool-use JSON output" —
      // `continue` is a field of the Stop-family hook output, not a PostToolUse
      // decision value. Verified empirically against codex-cli 0.149.0: the old
      // shape => "hook: PostToolUse Failed"; the hookSpecificOutput envelope
      // below => "hook: PostToolUse Completed" (its wire struct carries
      // hookEventName / additionalContext / updatedMCPToolOutput; the only
      // valid top-level decision is `block`, which this nudge never wants).
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
    case 'gemini':
      return { decision: 'continue', context: message };
    case 'cursor':
      return { permission: 'allow', userMessage: message };
    case 'opencode':
      return { message };
    case 'pi':
      // The pi extension reads `.message` and re-emits it via pi.sendMessage().
      return { message };
    default:
      return { message };
  }
}

// ── Runtime glue ─────────────────────────────────────────────────────────────

async function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    const timeout = setTimeout(() => resolve(null), 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try { resolve(data.trim() ? JSON.parse(data) : null); } catch { resolve(null); }
    });
    process.stdin.on('close', () => { clearTimeout(timeout); resolve(null); });
  });
}

function extractCommand(input) {
  // Handle several shapes: Claude Code PostToolUse, Codex hooks, Gemini, OpenCode tool.execute.after, Cursor afterShellExecution
  if (!input || typeof input !== 'object') return '';
  return (
    input?.tool_input?.command ||
    input?.tool_input?.cmd ||
    input?.toolInput?.command ||
    input?.toolInput?.cmd ||
    input?.args?.command ||
    input?.args?.cmd ||
    input?.input?.command ||
    input?.input?.cmd ||
    input?.payload?.command ||
    input?.payload?.cmd ||
    input?.command ||
    input?.cmd ||
    ''
  );
}

/**
 * Turn the directory a `cd`/`-C` named into an absolute path, or null when it
 * cannot be resolved statically.
 *
 * `~` and `$HOME` are the spellings the workflow itself emits, so they are
 * expanded. Any other `$…` is a shell variable whose value the hook does not
 * have; returning null (fall back to the hook's own cwd) is honest, while
 * guessing would be the original defect again.
 */
function resolveTargetDir(dir) {
  if (!dir) return null;
  let d = dir;
  if (d === '~') d = os.homedir();
  else if (d.startsWith('~/')) d = path.join(os.homedir(), d.slice(2));
  else if (d.startsWith('$HOME/') || d === '$HOME') d = path.join(os.homedir(), d.slice('$HOME'.length));
  if (d.includes('$') || d.startsWith('~')) return null;
  return path.isAbsolute(d) ? d : path.resolve(process.cwd(), d);
}

/**
 * The branch of the repo the push actually ran in.
 *
 * `cwd` is the directory the command moved into. Running the read there —
 * rather than leaning on the hook's own cwd — is the fix for BUG 40ff964b: the
 * session repo can be on 'main' while the push happens in a worktree on a
 * feature branch, and the old answer named the session repo.
 */
function getCurrentBranch(cwd) {
  try {
    const gitArgs = cwd
      ? ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']
      : ['rev-parse', '--abbrev-ref', 'HEAD'];
    return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return null; }
}

function emit(directive) {
  process.stdout.write(JSON.stringify(directive));
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  const clientIdx = args.indexOf('--client');
  const client = clientIdx >= 0 ? args[clientIdx + 1] : 'claude-code';

  const input = await readStdinJson();
  const command = extractCommand(input);
  if (!command) process.exit(0);

  const trigger = classifyTrigger(command);
  if (!trigger) process.exit(0);

  if (trigger.kind === 'open') {
    emit(buildDirective(client,
      'You just opened a PR. Reply by calling `register_pr(itemId, prNumber, repo, sizing, model, harness)` ' +
      'with sizing = { epic, story, task, bug } counted across all items included in this PR. ' +
      `Use the active item id as itemId, model = the model id you are running, and harness = "${client}". ` +
      `(CLI: \`agenfk pr-register … --model <id> --harness ${client}\`.)`));
  }

  // push trigger: only nudge if the branch already has a registered PR.
  // `HEAD` is a symbolic push SOURCE ("push the current branch"), not a branch
  // name — `git push -u origin HEAD` is the form the workflow itself recommends
  // ("push your branch"), so resolve it to the real branch instead of nudging
  // with the literal 'HEAD' (independent review finding, CGLAB-86). The
  // classifier stays a pure string parser; git resolution happens here, in the
  // directory the command moved into (BUG 40ff964b).
  const needsResolve = !trigger.branch || trigger.branch === 'HEAD';
  const targetDir = resolveTargetDir(trigger.cwd);
  // The command moved into a directory we cannot resolve ($VAR, ~user). The
  // branch is therefore unknowable, and reaching for the hook's own cwd would
  // report the session repo's branch - the exact bug this fixes. Stay silent
  // instead of guessing (review finding).
  if (needsResolve && trigger.cwd && !targetDir) process.exit(0);
  const branch = needsResolve ? getCurrentBranch(targetDir) : trigger.branch;
  if (!branch) process.exit(0);
  // We don't currently index PRs by branch, but the agent can still answer the
  // "did I add items to this PR?" question itself. Emit the directive
  // unconditionally and let the agent decide; the server-side dedup window
  // (last_sizing_check_at within 5 min) prevents wasted turns.
  emit(buildDirective(client,
    `You just pushed to '${branch}'. If this branch has an open PR registered with AgEnFK and ` +
    'more items were added since the last sizing, call `update_pr_sizing(prNumber, repo, sizing, model, harness)` ' +
    `with the new counts (model = the model id you are running, harness = "${client}"). If unchanged, take no action.`));
}

// ESM script entry detection: only run main() when executed directly, not when imported.
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    // Compare real filesystem paths, not `new URL(import.meta.url).pathname`:
    // on Windows the URL pathname is `/C:/...` while argv[1] is `C:\...`, so
    // a string compare never matched and the hook silently never ran.
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32'
      ? self.toLowerCase() === entry.toLowerCase()
      : self === entry;
  } catch { return false; }
})();
if (isMain) {
  main().catch(() => process.exit(0));
}
