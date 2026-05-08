/**
 * Tests for `agenfk upgrade --version <x> [--json]` (Story a5ac3bfd).
 *
 * The upgrade command must support:
 *  - `--version <x>` to pin to a specific tag instead of "latest"
 *  - `--json` to emit a single machine-readable line on stdout
 *  - idempotent same-version skip (status: 'noop'), no install/restart
 *  - clear failure when the tag does not resolve (status: 'failed')
 *
 * These are source-level tests (matching the existing upgrade-tier.test.ts
 * convention) — they verify the shape of the CLI source after implementation.
 * All tests fail until the feature lands.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../src/index.ts');
const readCli = () => (fs.existsSync(CLI_PATH) ? fs.readFileSync(CLI_PATH, 'utf8') : '');

// Slice the upgrade command's `.action(...)` body so assertions don't bleed
// into other commands that also use --json (e.g. list, flow, etc.).
function getUpgradeActionSection(cli: string): string {
  const cmdIdx = cli.indexOf(".command('upgrade')");
  if (cmdIdx === -1) return '';
  // Heuristic: include up to the next `program` definition or end of file.
  const after = cli.slice(cmdIdx);
  const nextProgram = after.indexOf('\nprogram\n', 50);
  return nextProgram === -1 ? after : after.slice(0, nextProgram);
}

// ── --version flag ────────────────────────────────────────────────────────────

describe('agenfk upgrade — --version flag', () => {
  it('declares a --version <x> option on the upgrade command', () => {
    const section = getUpgradeActionSection(readCli());
    expect(section.length).toBeGreaterThan(0);
    // commander syntax: .option('--version <x>', ...) or '--version <ver>'
    expect(section).toMatch(/\.option\(\s*['"]--version\s+<[^>]+>/);
  });

  it('passes the requested tag through to release resolution (not just "latest")', () => {
    const section = getUpgradeActionSection(readCli());
    // The action must consult options.version when deciding which tag to fetch.
    expect(section).toMatch(/options\.version/);
  });

  it('uses a tag-resolver that can target a specific tag (not only latest)', () => {
    const cli = readCli();
    // Either a new function or the existing one extended with a tag parameter.
    expect(cli).toMatch(/resolveReleaseTag|fetchReleaseTag\b|fetchReleaseTagByVersion|fetchTag\b/);
  });
});

// ── --json flag + machine-readable output ─────────────────────────────────────

describe('agenfk upgrade — --json output', () => {
  it('declares a --json option on the upgrade command', () => {
    const section = getUpgradeActionSection(readCli());
    expect(section.length).toBeGreaterThan(0);
    expect(section).toMatch(/\.option\(\s*['"]--json/);
  });

  it('emits a JSON object with status / fromVersion / toVersion fields', () => {
    const section = getUpgradeActionSection(readCli());
    // The action must build the result object before printing.
    expect(section).toMatch(/status['"]?\s*:/);
    expect(section).toMatch(/fromVersion/);
    expect(section).toMatch(/toVersion/);
  });

  it('emits each of the three terminal statuses (noop, upgraded, failed)', () => {
    const section = getUpgradeActionSection(readCli());
    expect(section).toMatch(/['"]noop['"]/);
    expect(section).toMatch(/['"]upgraded['"]/);
    expect(section).toMatch(/['"]failed['"]/);
  });

  it('writes the JSON line via process.stdout.write or console.log(JSON.stringify(...))', () => {
    const section = getUpgradeActionSection(readCli());
    // Either explicit stringify or stdout.write of the result object.
    expect(section).toMatch(/JSON\.stringify\s*\(/);
  });
});

// ── Idempotent same-version skip ──────────────────────────────────────────────

describe('agenfk upgrade — idempotent same-version skip', () => {
  it('short-circuits when targetVersion equals CURRENT_VERSION (without --force)', () => {
    const section = getUpgradeActionSection(readCli());
    // Existing skip path already exists for "latest"; ensure it covers the
    // pinned-version branch too — i.e. compares against CURRENT_VERSION.
    expect(section).toMatch(/CURRENT_VERSION/);
  });

  it('does not run the install script on a noop', () => {
    const section = getUpgradeActionSection(readCli());
    // The install script call must be inside the upgrade branch, not the noop branch.
    // We check by ensuring the install execution sits AFTER a version-equality guard.
    const installIdx = section.search(/install\.mjs/);
    const equalityIdx = section.search(/=== CURRENT_VERSION|CURRENT_VERSION ===|latestVersion === |latestVersion!==|latestVersion !==/);
    expect(installIdx).toBeGreaterThan(-1);
    expect(equalityIdx).toBeGreaterThan(-1);
    expect(equalityIdx).toBeLessThan(installIdx);
  });
});

// ── Failure path ──────────────────────────────────────────────────────────────

describe('agenfk upgrade — failure reporting', () => {
  it('handles a missing/invalid tag with a failed status (in --json mode)', () => {
    const section = getUpgradeActionSection(readCli());
    // The catch block must be aware of the json flag so it emits a failed
    // record instead of just chalking to stderr.
    expect(section).toMatch(/catch[\s\S]{0,400}options\.json|options\.json[\s\S]{0,400}failed|json[\s\S]{0,200}failed/i);
  });

  it('exits non-zero when status is failed', () => {
    const section = getUpgradeActionSection(readCli());
    expect(section).toMatch(/process\.exit\(1\)|process\.exit\(2\)|process\.exitCode\s*=\s*[12]/);
  });
});

// ── --json silences the figlet banner ─────────────────────────────────────────

describe('agenfk upgrade — --json suppresses non-JSON stdout', () => {
  it('the figlet banner gate already excludes --json invocations', () => {
    const cli = readCli();
    // Existing line at top of file: gate that suppresses banner when --json is present.
    expect(cli).toMatch(/process\.argv\.includes\(\s*['"]--json['"]\s*\)/);
  });
});
