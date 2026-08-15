/**
 * install.mjs — CLI-only-default behaviour (product decision: MCP registration
 * is OPT-IN). A plain install installs the CLI, services, skills, commands, rules
 * and the gatekeeper/enforcer/pr hooks, and persists withMcp=false. MCP is
 * registered only with --with-mcp; Codex is the exception (codexMcp defaults on).
 *
 * Behaviour-based: run the real installer / bootstrap against a throwaway $HOME
 * and assert on what they actually write, instead of grepping install.mjs.
 *
 * NOTE: the *client MCP registration* branches (opencode/cursor/codex/claude/
 * gemini) can't be exercised hermetically — they invoke the real client CLIs,
 * which aren't present under the sandbox's empty PATH, so those steps self-skip
 * and write nothing observable. Those source-greps were dropped in the
 * behaviour-based conversion (CGLAB-16); withMcp defaulting to false is asserted
 * via the persisted config below, which is the observable contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { runInstall, runBootstrap, cleanupHome, REPO_ROOT, type RunResult } from './helpers/runInstaller';

describe('install.mjs — default (CLI-only) install writes the expected artifacts', () => {
  let r: RunResult;
  const readJson = (...segs: string[]) => JSON.parse(readFileSync(r.p(...segs), 'utf8'));

  beforeAll(() => {
    // A plain install (no --with-mcp / --no-mcp) is the CLI-only default: MCP is
    // opt-in (withMcp stays false) but Codex keeps MCP on (codexMcp default).
    r = runInstall(['--rules-scope=global']);
  });
  afterAll(() => cleanupHome(r.home));

  it('completes successfully', () => {
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Installation Complete/);
  });

  it('installs the workflow rules (global CLAUDE.md)', () => {
    expect(existsSync(r.p('.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('installs the gatekeeper / mcp-enforcer / pr hook bins', () => {
    for (const bin of ['agenfk-gatekeeper', 'agenfk-mcp-enforcer', 'agenfk-pr-hook']) {
      expect(existsSync(r.p('.local', 'bin', bin))).toBe(true);
    }
  });

  it('wires the gatekeeper (Pre) and pr (Post) hooks into claude settings.json', () => {
    const settings = JSON.stringify(readJson('.claude', 'settings.json'));
    expect(settings).toContain('agenfk-gatekeeper');
    expect(settings).toContain('agenfk-pr-hook');
  });

  it('installs and wires the test guard, as an "ask" hook rather than a blocker', () => {
    // The guard hands the accept-the-test-change vs fix-the-code call to the
    // developer. It is only useful if it is actually registered on the edit AND
    // Bash tools (Bash so `rm`/`git rm` of a test file is caught too), and it
    // must never be installed as a hard block.
    expect(existsSync(r.p('.local', 'bin', 'agenfk-test-guard'))).toBe(true);
    expect(existsSync(r.p('.agenfk', 'bin', 'agenfk-test-guard.mjs'))).toBe(true);

    const entry = readJson('.claude', 'settings.json').hooks.PreToolUse
      .find((e: any) => JSON.stringify(e).includes('agenfk-test-guard'));
    expect(entry).toBeDefined();
    expect(entry.matcher).toContain('Edit');
    expect(entry.matcher).toContain('Bash');
    expect(readFileSync(r.p('.local', 'bin', 'agenfk-test-guard'), 'utf8')).not.toContain("'deny'");
  });

  it('installs the agenfk skills and slash commands', () => {
    const skills = readdirSync(r.p('.claude', 'skills')).filter((n) => n.startsWith('agenfk'));
    const commands = readdirSync(r.p('.claude', 'commands')).filter((n) => n.startsWith('agenfk'));
    expect(skills.length).toBeGreaterThan(5);
    expect(commands.length).toBeGreaterThan(5);
  });

  it('persists withMcp=false (CLI-only default) and codexMcp=true (Codex exception)', () => {
    const cfg = readJson('.agenfk', 'config.json');
    expect(cfg.withMcp).toBe(false);
    expect(cfg.codexMcp).toBe(true);
    expect(cfg.rulesScope).toBe('global');
  });

  it('does NOT delete workspace source when run from a checkout (cleanStaleSrc .git guard)', () => {
    // This install ran from the repo root (which has .git). The guard must skip
    // the stale-source cleanup so packages/*/src survive — regression guard for
    // the footgun where running install.mjs from a clone wiped the source tree.
    expect(r.stdout).toMatch(/Skipping stale-source cleanup/);
    expect(existsSync(path.join(REPO_ROOT, 'packages', 'cli', 'src'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'packages', 'server', 'src'))).toBe(true);
  });

  it('does not dirty tracked repo files (installer writes only under the sandbox HOME)', () => {
    // install.mjs (re)writes scripts/start-services.mjs at its rootDir (= this
    // repo). It is byte-identical to the committed file today, so the tree stays
    // clean — but assert it explicitly so any future drift in the template fails
    // loudly here instead of silently mutating a tracked file during the suite.
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'scripts/start-services.mjs'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    }).trim();
    expect(dirty).toBe('');
  });
});

describe('bin/agenfk.js refuses to run destructively from a source checkout', () => {
  let r: RunResult;
  beforeAll(() => {
    // cwd is the repo root (has .git); the bootstrap must refuse and NOT install.
    r = runBootstrap([]);
  });
  afterAll(() => cleanupHome(r.home));

  it('exits non-zero and does not perform an install', () => {
    expect(r.status).not.toBe(0);
    expect(existsSync(r.p('.claude', 'CLAUDE.md'))).toBe(false); // nothing installed
  });

  it('explains why and points at the safe alternative', () => {
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/source checkout|refus/i);
    expect(out).toMatch(/install:framework/);
  });
});
