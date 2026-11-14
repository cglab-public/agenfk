/**
 * CGLAB-621: the desktop installers must ride every release.
 *
 * desktop-release.yml used to trigger only on `desktop-v*` tags, a second tag the
 * release flow never pushed - so from v2.0.0-beta.37 to beta.43 every release
 * shipped without a single installer and nothing failed. These specs pin the
 * workflow to the tag the release flow DOES push (`v<version>`), and pin the
 * shared attach script both jobs use to put the files on that release.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { load } from 'js-yaml';
import { posixBash } from './helpers/posixShell';

const ROOT = path.resolve(__dirname, '../../../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/desktop-release.yml');
const ATTACH_SCRIPT = path.join(ROOT, 'scripts/attach-release-assets.sh');

type Step = {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Workflow = {
  on: { push?: { tags?: string[] }; workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { steps: Step[] }>;
};

const workflow = (): Workflow => load(fs.readFileSync(WORKFLOW, 'utf8')) as Workflow;

// The subset of GitHub's tag filter glob the workflow uses: `*` matches anything
// but `/`, `**` anything, and `[...]` is a character class.
function globMatches(pattern: string, ref: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      re += pattern.slice(i, end + 1);
      i = end;
    } else {
      re += c.replace(/[.+?^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(ref);
}

const triggeredBy = (tag: string) => (workflow().on.push?.tags ?? []).some((p) => globMatches(p, tag));

describe('desktop-release.yml trigger (CGLAB-621)', () => {
  it.each(['v2.0.0-beta.43', 'v2.0.0', 'v1.1.21-beta.4'])(
    'runs on the release tag the release flow pushes: %s',
    (tag) => {
      expect(triggeredBy(tag)).toBe(true);
    },
  );

  it('does not run on a hub-only tag, which has its own workflow', () => {
    expect(triggeredBy('hub-v2.0.0')).toBe(false);
  });

  it('does not run on a tag that merely starts with v', () => {
    expect(triggeredBy('vscode-extension')).toBe(false);
  });

  it('still runs on a desktop-v* tag, the way to rebuild an existing release', () => {
    expect(triggeredBy('desktop-v2.0.0-beta.43')).toBe(true);
  });

  it('can be re-run by hand for an existing release tag', () => {
    expect(workflow().on.workflow_dispatch?.inputs?.tag?.required).toBe(true);
  });
});

describe('scripts/attach-release-assets.sh (CGLAB-621)', () => {
  let dir: string;
  let log: string;
  let asset: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-assets-'));
    log = path.join(dir, 'gh.log');
    asset = path.join(dir, 'AgEnFK.Setup.exe');
    fs.writeFileSync(asset, 'installer');
    // A stand-in `gh` that records each call. `release view` fails its first
    // FAKE_GH_VIEW_FAILS calls (the release does not exist yet), `release view
    // --json` prints FAKE_GH_ASSETS, and `release create` exits FAKE_GH_CREATE_EXIT.
    const gh = path.join(dir, 'gh');
    const count = path.join(dir, 'views');
    fs.writeFileSync(
      gh,
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> "${log}"`,
        'if [ "$1 $2" = "release view" ]; then',
        '  if [ "$4" = "--json" ]; then printf "%s\\n" "$FAKE_GH_ASSETS"; exit 0; fi',
        `  n=$(cat "${count}" 2>/dev/null || echo 0); echo $((n + 1)) > "${count}"`,
        '  [ "$n" -lt "${FAKE_GH_VIEW_FAILS:-0}" ] && exit 1',
        '  exit 0',
        'fi',
        'if [ "$1 $2" = "release create" ]; then exit "${FAKE_GH_CREATE_EXIT:-0}"; fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    fs.chmodSync(gh, 0o755);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const NEVER = 1000;
  const run = (args: string[], fake: Record<string, string | number> = {}) =>
    // Git's bash on Windows, not WSL's: that is the one PATH finds first from PowerShell (#208).
    spawnSync(posixBash(), [ATTACH_SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        ATTACH_WAIT_SECONDS: '0',
        ATTACH_POLL_SECONDS: '0',
        ...Object.fromEntries(Object.entries(fake).map(([k, v]) => [k, String(v)])),
      },
    });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

  it('uploads onto an existing release, replacing assets of the same name', () => {
    const r = run(['v2.0.0-beta.43', asset]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual(['release view v2.0.0-beta.43', `release upload v2.0.0-beta.43 ${asset} --clobber`]);
  });

  it('strips a desktop- prefix so a legacy tag lands on the v* release', () => {
    const r = run(['desktop-v2.0.0-beta.43', asset]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toContain(`release upload v2.0.0-beta.43 ${asset} --clobber`);
  });

  it('creates a missing beta release as a pre-release', () => {
    const r = run(['v2.0.0-beta.44', asset], { FAKE_GH_VIEW_FAILS: NEVER });
    expect(r.status, r.stderr).toBe(0);
    const create = calls().find((c) => c.startsWith('release create'));
    expect(create).toMatch(/^release create v2\.0\.0-beta\.44 .*--prerelease/);
  });

  it('creates a missing stable release as a full release, never a pre-release', () => {
    const r = run(['v2.1.0', asset], { FAKE_GH_VIEW_FAILS: NEVER });
    expect(r.status, r.stderr).toBe(0);
    const create = calls().find((c) => c.startsWith('release create'));
    expect(create).toMatch(/^release create v2\.1\.0 /);
    expect(create).not.toContain('--prerelease');
  });

  it('waits for the release flow to create the release instead of creating it first', () => {
    const r = run(['v2.0.0-beta.44', asset], { FAKE_GH_VIEW_FAILS: 2, ATTACH_WAIT_SECONDS: 60 });
    expect(r.status, r.stderr).toBe(0);
    expect(calls().some((c) => c.startsWith('release create'))).toBe(false);
    expect(calls()).toContain(`release upload v2.0.0-beta.44 ${asset} --clobber`);
  });

  it('treats losing the create race to another platform job as success', () => {
    const r = run(['v2.0.0-beta.44', asset], { FAKE_GH_VIEW_FAILS: 1, FAKE_GH_CREATE_EXIT: 1 });
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toContain(`release upload v2.0.0-beta.44 ${asset} --clobber`);
  });

  it('refuses a tag that is not a version, which create would turn into a new release', () => {
    const r = run(['beta', asset]);
    expect(r.status).not.toBe(0);
    expect(calls()).toEqual([]);
  });

  it('--skip-existing keeps a file the release already has', () => {
    const r = run(['--skip-existing', 'v2.0.0-beta.43', asset], { FAKE_GH_ASSETS: 'AgEnFK.Setup.exe' });
    expect(r.status, r.stderr).toBe(0);
    expect(calls().some((c) => c.startsWith('release upload'))).toBe(false);
  });

  it('--skip-existing still uploads a file the release lacks', () => {
    const r = run(['--skip-existing', 'v2.0.0-beta.43', asset], { FAKE_GH_ASSETS: 'other.tar.gz' });
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toContain(`release upload v2.0.0-beta.43 ${asset} --clobber`);
  });

  it('fails loudly with no files instead of uploading nothing', () => {
    const r = run(['v2.0.0-beta.43']);
    expect(r.status).not.toBe(0);
    expect(calls().some((c) => c.startsWith('release upload'))).toBe(false);
  });

  it('fails loudly with no tag', () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(calls()).toEqual([]);
  });
});
