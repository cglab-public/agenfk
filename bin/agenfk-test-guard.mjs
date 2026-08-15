#!/usr/bin/env node
/**
 * AgEnFK Test Guard — PreToolUse hook.
 *
 * A failing existing test is a signal, not a chore: it may be the only guard on
 * a real requirement. When an agent is about to CHANGE (rewrite, relax, skip or
 * delete) a test that already exists, this hook stops and hands the decision to
 * the developer:
 *
 *   (1) accept the change to the test, or
 *   (2) keep the test as-is and fix the production code instead.
 *
 * It does NOT hard-block: on Claude Code it emits `permissionDecision: "ask"`,
 * so the developer answers with the permission prompt itself and the approved
 * edit goes through on the same turn. Adding NEW tests, and creating new test
 * files, are never flagged — only edits that alter test code that already exists.
 *
 * Usage in client config: `agenfk-test-guard --client <name>`
 */
import fs from 'fs';
import path from 'path';

// ── Pure helpers (also exported for unit tests) ──────────────────────────────

/** Source-ish extensions we consider "test code" when the path says test. */
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|kts|cs|scala|php|rs|swift|dart|ex|exs|ipynb)$/i;

/** Directory segments that mark a test tree. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing', 'e2e', 'it']);

/** Filename conventions that mark a test file, across the common ecosystems. */
const TEST_FILENAME = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,        // foo.test.ts, foo.spec.jsx
  /^test_[^/]*\.py$/i,                      // test_foo.py
  /_test\.py$/i,                            // foo_test.py
  /_test\.go$/i,                            // foo_test.go
  /_(?:test|spec)\.rb$/i,                   // foo_test.rb, foo_spec.rb
  /_(?:test|spec)\.(?:exs?|php|dart)$/i,    // foo_test.exs, FooTest.php variants below
  /(?:Test|Tests|Spec|Specs)\.(?:java|kt|kts|cs|scala|php)$/, // FooTest.java, FooSpec.scala
  /\.(?:test|spec)\.(?:py|rb|php|dart|ipynb)$/i,
];

/**
 * True when `filePath` looks like test code. Two independent signals: a
 * filename convention, or a code file sitting inside a test directory (which is
 * how Go/JVM/pytest suites and this repo's own `src/test/**` are laid out).
 */
export function isTestFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() || '';
  if (TEST_FILENAME.some((re) => re.test(base))) return true;
  if (!CODE_EXT.test(base)) return false;
  return normalized.split('/').slice(0, -1).some((seg) => TEST_DIRS.has(seg.toLowerCase()));
}

/** Markers that disable a test rather than change it — always worth a prompt. */
const SKIP_MARKERS = [
  /\b(?:it|test|describe|context|suite|bench)\s*\.\s*(?:skip|todo|failing)\b/,
  /\bx(?:it|test|describe|context)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bunittest\.skip\b/,
  /@(?:Ignore|Disabled)\b/,
  /\bt\.Skip\s*\(/,
  /\bt\.Parallel\s*\(\s*\)\s*;\s*t\.Skip\b/,
  /\[(?:Ignore|Skip)\]/,
  /\bskip\s*:\s*true\b/,
];

function addsSkipMarker(oldString, newString) {
  return SKIP_MARKERS.some((re) => re.test(newString || '') && !re.test(oldString || ''));
}

/**
 * Decide whether a single Edit-style replacement needs the developer's call.
 * Returns a short reason string, or null when the change is safe to wave through.
 *
 * Pure ADDITION is safe: if the new text still contains the old text verbatim,
 * nothing that existed was rewritten or removed — the agent is appending new
 * test cases, which never needs approval. Anything else rewrites or deletes
 * assertions that already existed.
 */
export function classifyEdit(oldString, newString) {
  const before = typeof oldString === 'string' ? oldString : '';
  const after = typeof newString === 'string' ? newString : '';
  if (addsSkipMarker(before, after)) return 'it disables a test (skip / todo / ignore marker)';
  if (!before) return null;                       // pure insertion
  if (after.includes(before)) return null;        // existing text preserved verbatim
  if (!after.trim()) return 'it deletes existing test code';
  return 'it rewrites test code that already exists';
}

/**
 * Decide whether a whole tool call needs the developer's call.
 * `exists` tells the classifier whether the target file is already on disk —
 * a brand-new test file is always allowed through.
 *
 * Returns { filePath, reason } when the developer must decide, else null.
 */
export function classifyToolCall(tool, toolInput, exists) {
  const name = String(tool || '').toLowerCase();
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const filePath = input.file_path || input.filePath || input.notebook_path || input.notebookPath || '';

  if (name === 'bash') return classifyBashCommand(input.command || input.cmd || '');
  if (!['edit', 'write', 'multiedit', 'notebookedit'].includes(name)) return null;
  if (!filePath || !isTestFile(filePath)) return null;
  if (!exists) return null; // creating a new test file — never gated

  if (name === 'write') {
    return { filePath, reason: 'it overwrites an existing test file wholesale' };
  }

  if (name === 'notebookedit') {
    // NotebookEdit sends only the replacement source, never the old cell — there
    // is no diff to reason about, so anything but a pure insert goes to the
    // developer.
    const mode = String(input.edit_mode || input.editMode || 'replace').toLowerCase();
    if (mode === 'insert') return null;
    return { filePath, reason: `it ${mode === 'delete' ? 'deletes' : 'replaces'} a cell in an existing test notebook` };
  }

  // Edit / MultiEdit: judge every replacement; the first one that isn't a pure
  // addition decides. `edits` covers MultiEdit-shaped input.
  const edits = Array.isArray(input.edits) && input.edits.length
    ? input.edits
    : [{ old_string: input.old_string ?? input.oldString, new_string: input.new_string ?? input.newString }];
  for (const edit of edits) {
    const reason = classifyEdit(edit?.old_string ?? edit?.oldString, edit?.new_string ?? edit?.newString);
    if (reason) return { filePath, reason };
  }
  return null;
}

/**
 * Deleting a test file happens through the shell, not through Edit — so the
 * guard also watches `rm` / `git rm` for test paths. Quote characters are
 * stripped so `rm "src/foo.test.ts"` is caught too.
 */
export function classifyBashCommand(command) {
  if (typeof command !== 'string' || !command) return null;
  if (!/(?:^|[\s;&|])(?:rm|unlink)\s|(?:^|[\s;&|])git\s+rm\s/.test(command)) return null;
  for (const raw of command.split(/[\s;&|]+/)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (token.startsWith('-')) continue;
    if (isTestFile(token) && fs.existsSync(path.resolve(token))) {
      return { filePath: token, reason: 'it deletes an existing test file' };
    }
  }
  return null;
}

/** The message the developer (and the agent) sees. */
export function buildReason({ filePath, reason }) {
  return [
    'AgEnFK TEST GUARD — this changes an EXISTING test.',
    '',
    `  File:   ${filePath}`,
    `  Why:    ${reason}`,
    '',
    'A failing or inconvenient existing test is a signal, not a chore — it may be',
    'the only guard on a real requirement. Ask the developer which they want:',
    '',
    '  (1) ACCEPT the test change — the test encoded behaviour that is now outdated.',
    '  (2) KEEP the test as-is and fix the production code instead.',
    '',
    'Approve this call only for (1). If it is denied, treat that as (2): restore the',
    'test untouched and fix the code under test. Adding NEW tests never needs approval.',
  ].join('\n');
}

/** Per-client shape for "stop and let the developer decide". */
export function buildDirective(client, reason) {
  switch (client) {
    case 'claude-code':
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: reason,
        },
      };
    case 'codex':
      return { decision: 'ask', reason };
    case 'gemini':
      return { decision: 'ask', context: reason };
    case 'cursor':
      return { permission: 'ask', userMessage: reason };
    case 'opencode':
    case 'pi':
      return { decision: 'ask', reason, message: reason };
    default:
      return { decision: 'ask', reason };
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

async function main() {
  const args = process.argv.slice(2);
  const clientIdx = args.indexOf('--client');
  const client = clientIdx >= 0 ? args[clientIdx + 1] : 'claude-code';

  const input = await readStdinJson();
  if (!input) process.exit(0);

  const tool = input.tool || input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || input.args || input.input || {};
  const filePath = toolInput?.file_path || toolInput?.filePath || toolInput?.notebook_path || toolInput?.notebookPath || '';
  const exists = Boolean(filePath) && fs.existsSync(path.resolve(filePath));

  const verdict = classifyToolCall(tool, toolInput, exists);
  if (!verdict) process.exit(0);

  process.stdout.write(JSON.stringify(buildDirective(client, buildReason(verdict))));
  process.exit(0);
}

// ESM entry detection: only run when executed directly, not when imported by tests.
const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    return process.argv[1] && url.pathname === process.argv[1];
  } catch { return false; }
})();
if (isMain) {
  main().catch(() => process.exit(0));
}
