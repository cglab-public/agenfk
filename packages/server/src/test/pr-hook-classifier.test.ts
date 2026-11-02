import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Importing the .mjs hook script directly. Pure helpers are exported by name.
// @ts-ignore — .mjs has no .d.ts; the helpers are JS functions.
import { classifyTrigger, buildDirective } from '../../../../bin/agenfk-pr-hook.mjs';

describe('classifyTrigger', () => {
  it('detects gh pr create', () => {
    expect(classifyTrigger('gh pr create --title foo --body bar')).toEqual({ kind: 'open' });
    expect(classifyTrigger("gh   pr   create --fill")).toEqual({ kind: 'open' });
  });

  it('detects git push and extracts branch when present', () => {
    expect(classifyTrigger('git push -u origin feature/x')).toEqual({ kind: 'push', branch: 'feature/x' });
    expect(classifyTrigger('git push origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD' });
    expect(classifyTrigger('git push')).toEqual({ kind: 'push', branch: undefined });
  });

  it('returns null for unrelated commands', () => {
    expect(classifyTrigger('ls -la')).toBeNull();
    expect(classifyTrigger('git status')).toBeNull();
    expect(classifyTrigger('gh pr view 123')).toBeNull();
  });

  it('handles multiline / leading whitespace', () => {
    expect(classifyTrigger('  gh pr create')).toEqual({ kind: 'open' });
  });
});

describe('classifyTrigger — the branch is the branch, not the shell plumbing (9d34c1c0)', () => {
  // The card reported `git push ... | tail -5` naming the branch 'tail'. That
  // no longer reproduces — the CGLAB-11 segment-aware rewrite splits on the
  // pipe, and line 230 below already covers it, so there is nothing to add
  // there. The live half of the same defect is a redirection whose TARGET is a
  // separate token: the filter only skipped tokens CONTAINING < or >, so a
  // detached target survived as the last non-flag token and was reported as
  // the branch the developer pushed to.
  const branchOf = (cmd: string) => (classifyTrigger(cmd) as any)?.branch;

  it('is not a redirection target written as its own token', () => {
    expect(branchOf('git push -u origin feat/x > out.txt')).toBe('feat/x');
    expect(branchOf('git push origin feat/x >> log.txt 2>&1')).toBe('feat/x');
    expect(branchOf('git push -u origin feat/x 2> /dev/null')).toBe('feat/x');
    expect(branchOf('git push origin feat/x 1> a.log 2> b.log')).toBe('feat/x');
  });

  it("is not a bash &> or {fd}> target either", () => {
    // Narrowing the old per-token filter to a cut regressed exactly these: the
    // cut anchored on optional DIGITS before the operator, so a token starting
    // with & or { sailed past it. Found by the review of this fix.
    expect(branchOf('git push -u origin feat/x &> out.txt')).toBe('feat/x');
    expect(branchOf('git push -u origin feat/x &>out.txt')).toBe('feat/x');
    expect(branchOf('git push -u origin feat/x &>>out.txt')).toBe('feat/x');
    expect(branchOf('git push -u origin feat/x {fd}>out.txt')).toBe('feat/x');
  });

  it('is still found when the redirection comes with no branch at all', () => {
    // Nothing to report rather than the log file — the caller falls back to the
    // current branch, which is right; naming out.txt is not.
    expect(branchOf('git push > out.txt')).toBeUndefined();
  });
});

describe('buildDirective', () => {
  const message = 'You just opened PR #N. Call register_pr(...).';

  it('claude-code: emits additionalContext', () => {
    expect(buildDirective('claude-code', message)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    });
  });

  // CGLAB-86: Codex 0.149.0 rejects the old {decision:'continue',reason}
  // envelope with "hook returned invalid post-tool-use JSON output" —
  // `continue` is a field of the Stop-family output, not a PostToolUse
  // decision value. Verified empirically against codex-cli 0.149.0: the old
  // shape prints "hook: PostToolUse Failed", the hookSpecificOutput shape
  // prints "hook: PostToolUse Completed". The valid nudge shape mirrors
  // Claude Code's hookSpecificOutput envelope (PostToolUseHookSpecificOutput
  // wire struct: hookEventName / additionalContext / updatedMCPToolOutput).
  it('codex: emits the valid PostToolUse hookSpecificOutput envelope', () => {
    expect(buildDirective('codex', message)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    });
  });

  it('codex: never emits a top-level decision field (only `block` is a valid PostToolUse decision)', () => {
    expect(buildDirective('codex', message)).not.toHaveProperty('decision');
  });

  it('gemini: emits context injection', () => {
    expect(buildDirective('gemini', message)).toEqual({
      decision: 'continue',
      context: message,
    });
  });

  it('cursor: emits permission/output shape', () => {
    expect(buildDirective('cursor', message)).toEqual({
      permission: 'allow',
      userMessage: message,
    });
  });

  it('opencode: returns shape consumable by tool.execute.after plugin', () => {
    expect(buildDirective('opencode', message)).toEqual({
      message,
    });
  });

  it('unknown client: falls back to a generic shape', () => {
    expect(buildDirective('mystery', message)).toEqual({ message });
  });
});

describe('runtime command extraction', () => {
  const hookPath = path.resolve(__dirname, '../../../../bin/agenfk-pr-hook.mjs');

  it('detects Codex shell payloads that use cmd instead of command', () => {
    const res = spawnSync(process.execPath, [hookPath, '--client', 'codex'], {
      input: JSON.stringify({ tool_input: { cmd: 'gh pr create --title fix' } }),
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('register_pr');
  });

  it('detects OpenCode payloads that use args.command', () => {
    const res = spawnSync(process.execPath, [hookPath, '--client', 'opencode'], {
      input: JSON.stringify({ args: { command: 'git push' } }),
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('update_pr_sizing');
  });

  // CGLAB-86 regression: the exact payload shape Codex pipes to PostToolUse
  // hooks (captured from a live codex-cli 0.149.0 session) must produce
  // schema-valid JSON on stdout for the codex client.
  it('emits valid PostToolUse JSON for a real Codex push payload', () => {
    const codexPayload = {
      session_id: '01a03454-b72d-7f92-bab5-d5fe4b3db16c',
      turn_id: '01a03454-b756-7051-8081-97f92946ed1f',
      hook_event_name: 'PostToolUse',
      model: 'gpt-5.6-terra',
      permission_mode: 'bypassPermissions',
      tool_name: 'Bash',
      tool_input: { command: 'git add -A && git commit -m x && git push -u origin HEAD' },
      tool_response: 'ok\n',
      tool_use_id: 'exec-44ec5461-ccbb-41d9-b2ab-dcd6e6e909d0',
    };
    const res = spawnSync(process.execPath, [hookPath, '--client', 'codex'], {
      input: JSON.stringify(codexPayload),
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out).not.toHaveProperty('decision'); // `decision: continue` is what codex rejected
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    // `git push -u origin HEAD` must resolve to the real branch (the hook runs
    // git in the test process cwd = repo root), not the literal symbolic
    // 'HEAD' — unless the repo is genuinely detached, in which case 'HEAD'
    // is the honest answer.
    const actualBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    expect(out.hookSpecificOutput.additionalContext).toContain(`pushed to '${actualBranch}'`);
  });

  it('emits nothing (valid no-op) when no trigger is present', () => {
    const res = spawnSync(process.execPath, [hookPath, '--client', 'codex'], {
      input: JSON.stringify({ tool_input: { command: 'npm test' } }),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });
});

// ── Segment-aware trigger detection (CGLAB-11) ───────────────────────────────
// The original classifier anchored ^gh pr create / ^git push on the WHOLE
// command, so compound and env-prefixed invocations never nudged the agent to
// register the PR — and pr.opened silently never fired for those flows.
describe('classifyTrigger — compound and env-prefixed commands', () => {
  it('detects gh pr create after a cd', () => {
    expect(classifyTrigger('cd /repo && gh pr create --fill')).toEqual({ kind: 'open' });
  });

  it('detects gh pr create behind env assignments', () => {
    expect(classifyTrigger('GH_TOKEN=xyz gh pr create --title t')).toEqual({ kind: 'open' });
    expect(classifyTrigger('A=1 B="two words" gh pr create')).toEqual({ kind: 'open' });
  });

  it('detects git push inside a chain and still extracts the branch', () => {
    expect(classifyTrigger('git add -A && git commit -m "x" && git push -u origin feat/y'))
      .toEqual({ kind: 'push', branch: 'feat/y' });
  });

  it('detects segments split by ; | and newlines', () => {
    expect(classifyTrigger('echo hi; gh pr create')).toEqual({ kind: 'open' });
    expect(classifyTrigger('gh pr create 2>&1 | tail -3')).toEqual({ kind: 'open' });
    expect(classifyTrigger('git fetch\ngit push origin main')).toEqual({ kind: 'push', branch: 'main' });
  });

  it('prefers the open trigger when a chain contains both push and create', () => {
    expect(classifyTrigger('git push -u origin feat/z && gh pr create --fill')).toEqual({ kind: 'open' });
  });

  it('does NOT fire on the words inside quoted strings', () => {
    expect(classifyTrigger('git commit -m "gh pr create later"')).toBeNull();
    expect(classifyTrigger("echo 'run git push when ready'")).toBeNull();
    expect(classifyTrigger('git commit -m "a && gh pr create"')).toBeNull();
  });

  it('still returns null for unrelated compound commands', () => {
    expect(classifyTrigger('cd /repo && npm test && ls')).toBeNull();
    expect(classifyTrigger('gh pr view 12 && gh pr checks 12')).toBeNull();
  });
});

// ── The branch belongs to the repo the push ran in (BUG 40ff964b) ─────────────
// `getCurrentBranch()` used to run in the HOOK's cwd while the intercepted
// command could `cd` into another repo first, so a push from a worktree/clone
// was reported as the session repo's branch - typically 'main'. The classifier
// now carries the target directory, and the runtime resolves HEAD there.
describe('classifyTrigger — the push target directory (BUG 40ff964b)', () => {
  it('carries the cd target as cwd', () => {
    expect(classifyTrigger('cd /repo && git push -u origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD', cwd: '/repo' });
    expect(classifyTrigger('cd /repo && git push -u origin feat/x')).toEqual({ kind: 'push', branch: 'feat/x', cwd: '/repo' });
    expect(classifyTrigger('cd ~/modelwarden && git push -q')).toEqual({ kind: 'push', branch: undefined, cwd: '~/modelwarden' });
  });

  it('carries a quoted cd target without the quotes', () => {
    expect(classifyTrigger('cd "/repo with spaces" && git push')).toEqual({ kind: 'push', branch: undefined, cwd: '/repo with spaces' });
    expect(classifyTrigger("cd '/repo with spaces' && git push")).toEqual({ kind: 'push', branch: undefined, cwd: '/repo with spaces' });
  });

  it('the last cd wins', () => {
    expect(classifyTrigger('cd /one && cd /two && git push origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD', cwd: '/two' });
  });

  it('joins a relative cd onto the previous cd target', () => {
    // The second cd is relative to the FIRST target, not to the hook's cwd.
    // Resolving it later against process.cwd() named a decoy repo's branch
    // (review finding on this fix).
    expect(classifyTrigger('cd /one && cd two && git push origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD', cwd: '/one/two' });
    expect(classifyTrigger('cd a && cd b && git push')).toEqual({ kind: 'push', branch: undefined, cwd: 'a/b' });
    expect(classifyTrigger('cd /one/ && cd two && git push')).toEqual({ kind: 'push', branch: undefined, cwd: '/one/two' });
  });

  it('an absolute or ~/\$ cd replaces the previous target', () => {
    expect(classifyTrigger('cd /one && cd /two && git push')).toEqual({ kind: 'push', branch: undefined, cwd: '/two' });
    expect(classifyTrigger('cd /one && cd ~/two && git push')).toEqual({ kind: 'push', branch: undefined, cwd: '~/two' });
    expect(classifyTrigger('cd /one && cd $WT && git push')).toEqual({ kind: 'push', branch: undefined, cwd: '$WT' });
  });

  it('carries the -C target of the push itself', () => {
    expect(classifyTrigger('git -C /repo push -u origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD', cwd: '/repo' });
    expect(classifyTrigger('git -C /repo push origin feat/x')).toEqual({ kind: 'push', branch: 'feat/x', cwd: '/repo' });
    expect(classifyTrigger('git -C/repo push origin feat/x')).toEqual({ kind: 'push', branch: 'feat/x', cwd: '/repo' });
  });

  it('-C on the push overrides an earlier cd', () => {
    expect(classifyTrigger('cd /one && git -C /two push origin HEAD')).toEqual({ kind: 'push', branch: 'HEAD', cwd: '/two' });
  });

  it('has no cwd when nothing changes directory', () => {
    expect(classifyTrigger('git push -u origin feat/x')).toEqual({ kind: 'push', branch: 'feat/x' });
  });

  it('other git commands carrying -C are not pushes', () => {
    expect(classifyTrigger('git -C /repo status')).toBeNull();
    expect(classifyTrigger('git -C /repo add -A && git -C /repo commit -m x')).toBeNull();
  });
});

describe('classifyTrigger — refspec destination is the branch (BUG 40ff964b)', () => {
  const branchOf = (cmd: string) => (classifyTrigger(cmd) as any)?.branch;

  it('takes the destination of a src:dst refspec', () => {
    expect(branchOf('git push origin HEAD:feat/x')).toBe('feat/x');
    expect(branchOf('git push -u origin HEAD:feat/x')).toBe('feat/x');
    expect(branchOf('git push origin feat/x:main')).toBe('main');
  });

  it('strips a fully-qualified refs/heads/ destination', () => {
    expect(branchOf('git push origin HEAD:refs/heads/feat/x')).toBe('feat/x');
    expect(branchOf('git push origin refs/heads/feat/x')).toBe('feat/x');
  });

  it('leaves a plain branch name alone', () => {
    expect(branchOf('git push origin feat/x')).toBe('feat/x');
    expect(branchOf('git push -u origin feat/x')).toBe('feat/x');
  });
});

describe('classifyTrigger — shell-semantics edge cases (adversarial review)', () => {
  it("handles the '\\'' apostrophe idiom in commit messages", () => {
    expect(classifyTrigger("git commit -m 'it'\\''s done' && git push origin main"))
      .toEqual({ kind: 'push', branch: 'main' });
  });

  it('2>&1 stays inside its segment and never becomes the branch', () => {
    expect(classifyTrigger('git push origin main 2>&1')).toEqual({ kind: 'push', branch: 'main' });
    expect(classifyTrigger('git push -u origin feat/x 2>&1 | tail -3')).toEqual({ kind: 'push', branch: 'feat/x' });
  });

  it('heredoc bodies cannot trigger (swallowed into their segment)', () => {
    expect(classifyTrigger('git commit -F- <<EOF\nsubject\ngit push origin main\nEOF')).toBeNull();
  });

  it('escaped backslash before a closing double quote does not desync quoting', () => {
    expect(classifyTrigger('echo "a\\\\" && gh pr create')).toEqual({ kind: 'open' });
  });
});

// ── End-to-end: the reported branch is the repo the push ran in ──────────────
// The pure-classifier tests above pin the parsing; these run the real hook
// binary with a real cwd and a real second repository, which is the shape the
// production false positives had (`cd <other-repo> && git push` from a session
// whose own repo sat on main).
describe('runtime branch resolution — the push target directory (BUG 40ff964b)', () => {
  const hookPath = path.resolve(__dirname, '../../../../bin/agenfk-pr-hook.mjs');

  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n');
    git(dir, 'add', 'file.txt');
    git(dir, 'commit', '-qm', 'init');
  }

  function pushBranch(dir: string, branch: string): void {
    git(dir, 'checkout', '-q', '-b', branch);
    fs.appendFileSync(path.join(dir, 'file.txt'), 'work\n');
    git(dir, 'commit', '-qam', 'work');
  }

  function runHook(sessionCwd: string, command: string): string {
    const res = spawnSync(process.execPath, [hookPath, '--client', 'claude-code'], {
      cwd: sessionCwd,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
  }

  it("reports the branch of the repo the command cd'd into, not the session repo's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-hook-'));
    try {
      const session = path.join(root, 'session-repo');
      const target = path.join(root, 'target-repo');
      initRepo(session);          // session repo stays on main
      initRepo(target);
      pushBranch(target, 'feat/CGLAB-425_provenance');

      const ctx = runHook(session, `cd ${target} && git push -u origin HEAD`);
      expect(ctx).toContain("pushed to 'feat/CGLAB-425_provenance'");
      expect(ctx).not.toContain("pushed to 'main'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the target branch for `git -C <repo> push`', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-hook-'));
    try {
      const session = path.join(root, 'session-repo');
      const target = path.join(root, 'target-repo');
      initRepo(session);
      initRepo(target);
      pushBranch(target, 'feat/CGLAB-427_within-dir');

      const ctx = runHook(session, `git -C ${target} push -u origin HEAD`);
      expect(ctx).toContain("pushed to 'feat/CGLAB-427_within-dir'");
      expect(ctx).not.toContain("pushed to 'main'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still resolves a bare push in the hook cwd when no cd is present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-hook-'));
    try {
      const session = path.join(root, 'session-repo');
      initRepo(session);
      pushBranch(session, 'feat/CGLAB-428_no-cd');

      const ctx = runHook(session, 'git push -u origin HEAD');
      expect(ctx).toContain("pushed to 'feat/CGLAB-428_no-cd'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Unresolvable / relative targets (review findings on BUG 40ff964b) ────────
describe('runtime branch resolution — relative and unresolved targets', () => {
  const hookPath = path.resolve(__dirname, '../../../../bin/agenfk-pr-hook.mjs');

  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n');
    git(dir, 'add', 'file.txt');
    git(dir, 'commit', '-qm', 'init');
  }
  function pushBranch(dir: string, branch: string): void {
    git(dir, 'checkout', '-q', '-b', branch);
    fs.appendFileSync(path.join(dir, 'file.txt'), 'work\n');
    git(dir, 'commit', '-qam', 'work');
  }
  function rawHook(sessionCwd: string, command: string) {
    return spawnSync(process.execPath, [hookPath, '--client', 'claude-code'], {
      cwd: sessionCwd,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8',
    });
  }
  function contextOf(sessionCwd: string, command: string): string {
    const res = rawHook(sessionCwd, command);
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
  }

  it('resolves a relative cd target against the hook cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-hook-'));
    try {
      const session = path.join(root, 'session-repo');
      initRepo(session);                              // session repo on main
      const nested = path.join(session, 'sub');
      initRepo(nested);                               // nested repo, relative target
      pushBranch(nested, 'feat/CGLAB-429_relative');

      const ctx = contextOf(session, 'cd sub && git push -u origin HEAD');
      expect(ctx).toContain("pushed to 'feat/CGLAB-429_relative'");
      expect(ctx).not.toContain("pushed to 'main'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a ~-spelled cd target', () => {
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-hook-'));
    const home = fs.mkdtempSync(path.join(os.homedir(), '.agenfk-hook-test-'));
    try {
      initRepo(session);
      initRepo(home);
      pushBranch(home, 'feat/CGLAB-430_tilde');

      const ctx = contextOf(session, `cd ~/${path.basename(home)} && git push -u origin HEAD`);
      expect(ctx).toContain("pushed to 'feat/CGLAB-430_tilde'");
      expect(ctx).not.toContain("pushed to 'main'");
    } finally {
      fs.rmSync(session, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('stays silent when the cd target is an unresolved shell variable', () => {
    // The hook KNOWS the directory changed but cannot know to what. Falling
    // back to its own cwd would report the session repo's branch - the very
    // bug this fix removes. No nudge is the honest answer.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-pr-hook-'));
    try {
      const session = path.join(root, 'session-repo');
      initRepo(session);
      pushBranch(session, 'feat/CGLAB-431_session-branch');

      const res = rawHook(session, 'cd $SOME_UNRESOLVED_VAR && git push -u origin HEAD');
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
