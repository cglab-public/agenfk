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
import http from 'http';
import { execSync } from 'child_process';

const API_URL = process.env.AGENFK_API_URL || 'http://127.0.0.1:3000';

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

export function classifyTrigger(command) {
  if (typeof command !== 'string') return null;
  // Segment-aware (CGLAB-11): the old ^-anchored match on the whole command
  // missed `cd x && gh pr create` and `GH_TOKEN=x gh pr create`, so those PRs
  // never got the register nudge. An `open` anywhere in the chain wins over a
  // `push` (the same chain often pushes then opens).
  let push = null;
  for (const rawSegment of splitShellSegments(command)) {
    const segment = stripEnvAssignments(rawSegment);
    if (/^gh\s+pr\s+create\b/.test(segment)) return { kind: 'open' };
    const pushMatch = segment.match(/^git\s+push\b(.*)$/);
    if (pushMatch && !push) {
      const rest = (pushMatch[1] || '').trim().split(/\s+/);
      // crude branch extraction: last non-flag token, ignoring 'origin' / '-u'
      // and redirections (2>&1, >out) that survive segment splitting.
      let branch;
      for (let i = rest.length - 1; i >= 0; i--) {
        const tok = rest[i];
        if (!tok || tok.startsWith('-')) continue;
        if (tok === 'origin') continue;
        if (/[<>]/.test(tok)) continue;
        branch = tok;
        break;
      }
      push = { kind: 'push', branch };
    }
  }
  return push;
}

export function buildDirective(client, message) {
  switch (client) {
    case 'claude-code':
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
    case 'codex':
      return { decision: 'continue', reason: message };
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

function getCurrentBranch() {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function fetchJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
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
  const branch = trigger.branch || getCurrentBranch();
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
    const url = new URL(import.meta.url);
    return process.argv[1] && url.pathname === process.argv[1];
  } catch { return false; }
})();
if (isMain) {
  main().catch(() => process.exit(0));
}
