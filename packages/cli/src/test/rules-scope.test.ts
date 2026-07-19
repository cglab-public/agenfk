/**
 * rulesScope feature — where workflow rules are installed (global HOME vs the
 * current project) and how uninstall cleans them up.
 *
 * Behaviour-based: run the real installer/uninstaller against a throwaway $HOME
 * (and a throwaway project cwd for project scope) and assert on what they write /
 * remove, instead of grepping install.mjs / uninstall.mjs / cli/index.ts.
 *
 * NOTE: the AGENTS.md (Codex) and GEMINI.md (Gemini) rule writers only fire when
 * that client is detected, which needs the real client CLI — absent under the
 * sandbox's empty PATH — so only the always-written claude (CLAUDE.md) and cursor
 * (agenfk.mdc) rules are observable here. The `integration install` command has
 * no `--scope` flag (it forwards the persisted rulesScope from config.json); the
 * old `--scope` grep was a false match on `claude mcp add --scope user`. Those
 * non-observable branches were dropped in the behaviour-based conversion
 * (CGLAB-16).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { runInstall, runUninstall, makeHome, cleanupHome, type RunResult } from './helpers/runInstaller';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';

const readJson = (r: RunResult, ...segs: string[]) => JSON.parse(readFileSync(r.p(...segs), 'utf8'));

describe('install.mjs — rulesScope=global installs rules into the global HOME', () => {
  let r: RunResult;
  beforeAll(() => { r = runInstall(['--rules-scope=global']); });
  afterAll(() => cleanupHome(r.home));

  it('writes the claude rules to ~/.claude/CLAUDE.md with agenfk content', () => {
    const p = r.p('.claude', 'CLAUDE.md');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toMatch(/agenfk/i);
  });

  it('writes the cursor rules to ~/.cursor/rules/agenfk.mdc', () => {
    expect(existsSync(r.p('.cursor', 'rules', 'agenfk.mdc'))).toBe(true);
  });

  it('persists rulesScope=global to config.json', () => {
    expect(readJson(r, '.agenfk', 'config.json').rulesScope).toBe('global');
  });
});

describe('install.mjs — rulesScope=project routes rules to the project, not the global HOME', () => {
  let r: RunResult;
  let project: string;
  beforeAll(() => {
    project = mkdtempSync(path.join(os.tmpdir(), 'agenfk-proj-'));
    r = runInstall(['--rules-scope=project'], makeHome('agenfk-install'), project);
  });
  afterAll(() => {
    cleanupHome(r.home);
    rmSync(project, { recursive: true, force: true });
  });

  it('persists rulesScope=project to config.json', () => {
    expect(readJson(r, '.agenfk', 'config.json').rulesScope).toBe('project');
  });

  it('does NOT write the global ~/.claude/CLAUDE.md (rules are scoped to the project)', () => {
    expect(existsSync(r.p('.claude', 'CLAUDE.md'))).toBe(false);
  });
});

describe('uninstall.mjs — removes the installed rules', () => {
  let home: string;
  let install: RunResult;
  let uninstall: RunResult;
  let mdcExistedAfterInstall = false;
  beforeAll(() => {
    home = makeHome('agenfk-rules-uninstall');
    install = runInstall(['--rules-scope=global'], home);
    mdcExistedAfterInstall = existsSync(install.p('.cursor', 'rules', 'agenfk.mdc'));
    uninstall = runUninstall(['-y'], home);
  });
  afterAll(() => cleanupHome(home));

  it('the install first wrote the rules (precondition)', () => {
    expect(install.status).toBe(0);
    expect(mdcExistedAfterInstall).toBe(true);
  });

  it('fully removes the cursor agenfk.mdc rule file', () => {
    expect(existsSync(uninstall.p('.cursor', 'rules', 'agenfk.mdc'))).toBe(false);
  });

  it('strips the agenfk block from the shared CLAUDE.md', () => {
    const p = uninstall.p('.claude', 'CLAUDE.md');
    // The shared file may remain (possibly empty) but must carry no agenfk content.
    const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
    expect(content).not.toMatch(/agenfk/i);
  });
});
