/**
 * BUG 4bd98e16: the npx installers resolved the release to download by DATE
 * and with no hub-tag filter. `--beta` took the most recently published
 * release of any kind (its gh fallback: `--limit 1` of any kind), so a hub
 * image release (`hub-v*`) or a hotfix on an older line could be installed as
 * the framework; the stable path took /releases/latest, which is also a hub
 * release when one is published without --prerelease (observed in production
 * for the CLI, b233143b). The rule is the CLI's newestChannelRelease: hub tags
 * never, the channel's newest by VERSION.
 *
 * Each installer runs for real against a throwaway HOME, with stub curl/gh on
 * PATH that answer from a table and record the download URL instead of
 * fetching it - the URL is what the installer chose.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, cpSync, rmSync, symlinkSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';
import { newestChannelTag } from '../../../../bin/version-utils.mjs';

let work: string;
beforeAll(() => { work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-channel-')); });
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Rel = { tag_name: string; prerelease: boolean; published_at: string };
const rel = (tag_name: string, prerelease: boolean, published_at: string): Rel => ({ tag_name, prerelease, published_at });

// Newest by date first, as GitHub lists them.
const RELEASES: Rel[] = [
  rel('hub-v2.1.0-beta.1', true, '2026-10-09T00:00:00Z'),  // the hub image, newest of all
  rel('hub-v2.1.0', false, '2026-10-08T00:00:00Z'),        // a hub release made without --prerelease
  rel('v1.1.22-beta.1', true, '2026-10-07T00:00:00Z'),     // a beta on the OLDER line, published last
  rel('v1.1.21', false, '2026-10-06T00:00:00Z'),           // a hotfix on the older line, published last
  rel('v2.0.1-beta.2', true, '2026-10-03T00:00:00Z'),
  rel('v2.0.0', false, '2026-10-02T00:00:00Z'),
  rel('v2.0.1-beta.1', true, '2026-10-01T00:00:00Z'),
];

/** A PATH with node, tar, gzip and stub curl/gh. `api` false makes every GitHub API call fail. */
function makeBin(opts: { api: boolean; latest: string; releases?: Rel[]; listFails?: boolean; ghDown?: boolean }) {
  const releases = opts.releases ?? RELEASES;
  const binDir = mkdtempSync(path.join(work, 'bin-'));
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  // git: packages/create refuses to start without it; on an existing install it never clones.
  for (const tool of ['tar', 'gzip', 'cat', 'printf', 'git']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, path.join(binDir, tool));
  }
  const data = path.join(work, `data-${Math.random().toString(36).slice(2)}`);
  mkdirSync(data);
  writeFileSync(path.join(data, 'list.json'), JSON.stringify(releases));
  writeFileSync(path.join(data, 'latest.json'), JSON.stringify({ tag_name: opts.latest }));
  writeFileSync(path.join(data, 'gh-list.json'), JSON.stringify(releases.map(r => ({ tagName: r.tag_name, isPrerelease: r.prerelease, createdAt: r.published_at }))));
  // What the OLD `gh release list --limit 1 --template '{{range .}}{{.tagName}}{{end}}'` printed: the newest by date.
  writeFileSync(path.join(data, 'gh-first.txt'), releases[0]?.tag_name ?? '');
  const ghArgs = path.join(data, 'gh-args.log');
  const log = path.join(data, 'downloads.log');
  writeFileSync(path.join(binDir, 'curl'), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; http*) url="$1";; esac; shift; done
if [ -n "$out" ]; then printf '%s\\n' "$url" >> ${JSON.stringify(log)}; exit 22; fi
${opts.api ? '' : 'exit 22'}
case "$url" in
  */releases/latest) cat ${JSON.stringify(path.join(data, 'latest.json'))};;
  */releases\\?*) ${opts.listFails ? 'exit 22' : `cat ${JSON.stringify(path.join(data, 'list.json'))}`};;
  *) exit 22;;
esac
`);
  writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(path.join(data, 'gh-args.log'))}
${opts.ghDown ? 'exit 1' : ''}
case "$2" in
  list) case "$*" in *"--limit 1 "*) cat ${JSON.stringify(path.join(data, 'gh-first.txt'))};; *) cat ${JSON.stringify(path.join(data, 'gh-list.json'))};; esac;;
  view) printf '%s' ${JSON.stringify(opts.latest)};;
  download) printf '%s\\n' "gh:$3" >> ${JSON.stringify(log)}; exit 1;;
  *) exit 1;;
esac
`);
  chmodSync(path.join(binDir, 'curl'), 0o755);
  chmodSync(path.join(binDir, 'gh'), 0o755);
  return {
    binDir,
    downloads: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    ghCalls: () => (existsSync(ghArgs) ? readFileSync(ghArgs, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

/** The tag in the first download the installer attempted. */
const tagOf = (downloads: string[]) => {
  const d = downloads.find(u => /releases\/download\/|^gh:/.test(u));
  return d?.match(/releases\/download\/([^/]+)\//)?.[1] ?? d?.replace(/^gh:/, '');
};

/** A .git-less copy of the repo: what `npx github:…` runs (bin/agenfk.js). */
function rootSource(): string {
  const source = mkdtempSync(path.join(work, 'src-'));
  for (const dir of ['bin', 'scripts', 'commands']) cpSync(path.join(REPO_ROOT, dir), path.join(source, dir), { recursive: true });
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'agenfk', version: '0.0.1' }));
  return source;
}

/** An existing, non-git install on an old version, so the update branch downloads. */
function oldInstall(home: string) {
  const dir = path.join(home, '.agenfk-system');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agenfk', version: '0.0.1' }));
}

function runRoot(args: string[], bin: string) {
  const home = mkdtempSync(path.join(work, 'home-'));
  oldInstall(home);
  return spawnSync(process.execPath, [path.join(rootSource(), 'bin', 'agenfk.js'), ...args], {
    encoding: 'utf8', timeout: 180_000,
    env: { HOME: home, USERPROFILE: home, PATH: bin, NODE_ENV: 'production', VITEST: '1' },
  });
}

function runCreate(bin: string) {
  const home = mkdtempSync(path.join(work, 'home-'));
  oldInstall(home);
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'packages', 'create', 'bin', 'agenfk.js')], {
    encoding: 'utf8', timeout: 60_000,
    env: { HOME: home, USERPROFILE: home, PATH: bin, NODE_ENV: 'production', VITEST: '1' },
  });
}

describe('newestChannelTag (bin/version-utils.mjs)', () => {
  const refs = RELEASES.map(r => ({ tag: r.tag_name, prerelease: r.prerelease, publishedAt: Date.parse(r.published_at) }));

  it('beta: the newest prerelease by version, never a hub tag or an older line published later', () => {
    expect(newestChannelTag(refs, true)).toBe('v2.0.1-beta.2');
  });

  it('stable: the newest stable by version, never a hub tag or an older-line hotfix', () => {
    expect(newestChannelTag(refs, false)).toBe('v2.0.0');
  });

  it('stable: never a beta published without --prerelease', () => {
    expect(newestChannelTag([
      { tag: 'v2.1.0-beta.1', prerelease: false, publishedAt: 2 },
      { tag: 'v2.0.1', prerelease: false, publishedAt: 1 },
    ], false)).toBe('v2.0.1');
  });

  it('null when the channel has nothing but hub tags', () => {
    expect(newestChannelTag([{ tag: 'hub-v1.0.0', prerelease: false, publishedAt: 1 }], false)).toBeNull();
  });
});

describe('npx github:cglab-public/agenfk (bin/agenfk.js) downloads the right release', () => {
  it('--beta: the newest framework prerelease by version', () => {
    const b = makeBin({ api: true, latest: 'hub-v2.1.0' });
    const r = runRoot(['--beta'], b.binDir);
    expect(tagOf(b.downloads()), `${r.stdout}${r.stderr}`.slice(-2000)).toBe('v2.0.1-beta.2');
  });

  it('stable: the newest framework stable by version, even when /releases/latest is a hub tag', () => {
    const b = makeBin({ api: true, latest: 'hub-v2.1.0' });
    const r = runRoot([], b.binDir);
    expect(tagOf(b.downloads()), `${r.stdout}${r.stderr}`.slice(-2000)).toBe('v2.0.0');
  });

  it('--beta through the gh fallback (GitHub API down): same rule, not `--limit 1` of any kind', () => {
    const b = makeBin({ api: false, latest: 'hub-v2.1.0' });
    const r = runRoot(['--beta'], b.binDir);
    expect(tagOf(b.downloads()), `${r.stdout}${r.stderr}`.slice(-2000)).toBe('v2.0.1-beta.2');
  });
});

describe('bin/agenfk.js, review round (BUG 4bd98e16)', () => {
  // A beta whose stable has shipped, with no newer beta: --beta includes stable.
  const GRADUATED: Rel[] = [rel('v2.0.0', false, '2026-10-05T00:00:00Z'), rel('v2.0.0-beta.23', true, '2026-10-01T00:00:00Z')];

  it('--beta takes the stable that graduates the beta', () => {
    const b = makeBin({ api: true, latest: 'v2.0.0', releases: GRADUATED });
    runRoot(['--beta'], b.binDir);
    expect(tagOf(b.downloads())).toBe('v2.0.0');
  });

  it("stable: GitHub's latest is a real candidate, kept when the list request fails", () => {
    // gh down too, so only the REST path can answer: it must keep latest.
    const b = makeBin({ api: true, latest: 'v2.0.0', listFails: true, ghDown: true });
    runRoot([], b.binDir);
    expect(tagOf(b.downloads())).toBe('v2.0.0');
  });

  it("stable: GitHub's latest counts beside a list that holds no stable", () => {
    const b = makeBin({ api: true, latest: 'v1.1.20', releases: [rel('v2.0.0-beta.23', true, '2026-10-01T00:00:00Z')], ghDown: true });
    runRoot([], b.binDir);
    expect(tagOf(b.downloads())).toBe('v1.1.20');
  });

  it('--beta with a failed list asks gh for the beta rather than settling for the stable latest', () => {
    const b = makeBin({ api: true, latest: 'v2.0.0', listFails: true,
      releases: [rel('v2.1.0-beta.3', true, '2026-10-06T00:00:00Z'), rel('v2.0.0', false, '2026-10-01T00:00:00Z')] });
    runRoot(['--beta'], b.binDir);
    expect(tagOf(b.downloads())).toBe('v2.1.0-beta.3');
  });

  it('the gh fallback asks for the list without drafts', () => {
    const b = makeBin({ api: false, latest: 'hub-v2.1.0' });
    runRoot(['--beta'], b.binDir);
    expect(b.ghCalls().find(c => c.startsWith('release list'))).toMatch(/--exclude-drafts/);
  });
});

describe('npx agenfk (packages/create) downloads the right release', () => {
  it('stable: never a hub tag, newest stable by version', () => {
    const b = makeBin({ api: true, latest: 'hub-v2.1.0' });
    const r = runCreate(b.binDir);
    expect(tagOf(b.downloads()), `${r.stdout}${r.stderr}`.slice(-2000)).toBe('v2.0.0');
  });

  it('through the gh fallback (GitHub API down): same rule', () => {
    const b = makeBin({ api: false, latest: 'hub-v2.1.0' });
    const r = runCreate(b.binDir);
    expect(tagOf(b.downloads()), `${r.stdout}${r.stderr}`.slice(-2000)).toBe('v2.0.0');
  });

  it("keeps GitHub's latest when the list request fails (gh down too)", () => {
    const b = makeBin({ api: true, latest: 'v2.0.0', listFails: true, ghDown: true });
    runCreate(b.binDir);
    expect(tagOf(b.downloads())).toBe('v2.0.0');
  });

  it('the gh fallback asks for the list without drafts', () => {
    const b = makeBin({ api: false, latest: 'hub-v2.1.0' });
    runCreate(b.binDir);
    expect(b.ghCalls().find(c => c.startsWith('release list'))).toMatch(/--exclude-drafts/);
  });
});
