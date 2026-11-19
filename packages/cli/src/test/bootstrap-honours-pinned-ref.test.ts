/**
 * Issue #216 — `npx github:cglab-public/agenfk#<tag>` must install THAT tag.
 *
 * The bootstrap copied the requested ref's source into ~/.agenfk-system and
 * then extracted the dist of whatever release was newest on the channel over
 * it: package.json and every packages/x/dist came from another release. A user
 * who pinned a tag to reproduce a known version silently got a mix.
 *
 * npx records the spec it was asked for in its cache directory's package.json
 * (`_npx.packages`, `dependencies`), two levels above the package itself
 * (<cache>/node_modules/agenfk). That is how the bootstrap learns the pin.
 *
 * Offline: curl is a stub that serves a release list and records which release
 * asset was requested; each tag's archive carries a marker command.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';
import { fakeBin, hostTar } from './helpers/fakeBin';

let work: string;
const LATEST = 'v9.9.9';
const TAGS = [LATEST, 'v2.0.0-beta.35', 'v2.0.0-beta.40', 'v1.0.0'];
/** A release whose archive downloads fine but is not a gzip tarball. */
const CORRUPT = 'v4.0.0';

/** One archive per tag, each shipping a command named after its tag. */
function makeArchives(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of TAGS) {
    const stage = mkdtempSync(path.join(work, 'stage-'));
    cpSync(path.join(REPO_ROOT, 'commands'), path.join(stage, 'commands'), { recursive: true });
    writeFileSync(path.join(stage, 'commands', `from-${tag}.md`), '---\ndescription: x\n---\nmarker\n', 'utf8');
    const tarball = path.join(work, `dist-${tag}.tar.gz`);
    spawnSync(hostTar(), ['-czf', tarball, '-C', stage, 'commands'], { encoding: 'utf8' });
    out[tag] = tarball;
  }
  return out;
}

/** <cache>/node_modules/agenfk, with <cache>/package.json recording `spec`. */
function makeNpxSource(spec: string | null, version: string): string {
  const cache = mkdtempSync(path.join(work, 'npx-'));
  const source = path.join(cache, 'node_modules', 'agenfk');
  for (const dir of ['bin', 'scripts', 'commands']) {
    cpSync(path.join(REPO_ROOT, dir), path.join(source, dir), { recursive: true });
  }
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'agenfk', version }), 'utf8');
  if (spec !== null) {
    writeFileSync(path.join(cache, 'package.json'), JSON.stringify({
      dependencies: { agenfk: spec },
      _npx: { packages: [spec] },
    }), 'utf8');
  }
  return source;
}

function makeInstallDir(home: string, version: string): string {
  const installDir = path.join(home, '.agenfk-system');
  mkdirSync(path.join(installDir, 'commands'), { recursive: true });
  writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'agenfk', version }), 'utf8');
  for (const pkg of ['core', 'storage-sqlite', 'telemetry', 'cli', 'server']) {
    mkdirSync(path.join(installDir, 'packages', pkg, 'dist'), { recursive: true });
    writeFileSync(path.join(installDir, 'packages', pkg, 'dist', 'index.js'), 'built\n', 'utf8');
  }
  return installDir;
}

/** Runs the bootstrap; returns the release tags whose dist it downloaded. */
function bootstrap(source: string, home: string, archives: Record<string, string>, args: string[] = []) {
  const log = path.join(work, `curl-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '', 'utf8');
  const bin = fakeBin(mkdtempSync(path.join(work, 'bin-')), {
    node: true,
    tools: ['tar', 'gzip'],
    stubs: {
      curl: `const fs = require('fs');
const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a)) || '';
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : '';
const archives = ${JSON.stringify(archives)};
const m = url.match(/releases\\/download\\/([^/]+)\\/agenfk-dist\\.tar\\.gz/);
if (out && m) {
  fs.appendFileSync(${JSON.stringify(log)}, m[1] + '\\n');
  if (!archives[m[1]]) process.exit(22);
  fs.copyFileSync(archives[m[1]], out);
} else if (/releases\\/latest/.test(url)) {
  console.log(JSON.stringify({ tag_name: ${JSON.stringify(LATEST)} }));
} else {
  console.log(JSON.stringify(${JSON.stringify(TAGS)}.map((t) => ({ tag_name: t, prerelease: /-/.test(t), published_at: '2026-01-01T00:00:00Z' }))));
}
`,
    },
  });
  const r = spawnSync(process.execPath, [path.join(source, 'bin', 'agenfk.js'), ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: bin.env({ HOME: home, USERPROFILE: home, NODE_ENV: 'production', VITEST: '1' }),
  });
  const downloaded = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { r, downloaded };
}

/**
 * Every download was `tag` (install.mjs's own self-heal may fetch again by the
 * source's version, so the count is not the contract - the tag is).
 */
const onlyFetched = (downloaded: string[], tag: string) => {
  expect(downloaded.length).toBeGreaterThan(0);
  expect([...new Set(downloaded)]).toEqual([tag]);
};

let archives: Record<string, string>;
beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'agenfk-pinned-'));
  archives = makeArchives();
  archives[CORRUPT] = path.join(work, 'corrupt.tar.gz');
  writeFileSync(archives[CORRUPT], 'this is not a gzip tarball\n', 'utf8');
});
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('npx github:cglab-public/agenfk#<tag> installs that tag (#216)', () => {
  it('downloads the pinned release, not the newest one', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const installDir = makeInstallDir(home, '1.0.0');
    const { downloaded } = bootstrap(makeNpxSource('github:cglab-public/agenfk#v2.0.0-beta.35', '2.0.0-beta.35'), home, archives, ['--beta']);
    onlyFetched(downloaded, 'v2.0.0-beta.35');
    expect(existsSync(path.join(installDir, 'commands', 'from-v2.0.0-beta.35.md'))).toBe(true);
    expect(existsSync(path.join(installDir, 'commands', `from-${LATEST}.md`))).toBe(false);
  });

  it('honours the pin on a fresh install too', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const { downloaded } = bootstrap(makeNpxSource('github:cglab-public/agenfk#v2.0.0-beta.35', '2.0.0-beta.35'), home, archives);
    onlyFetched(downloaded, 'v2.0.0-beta.35');
  });

  it('a pinned branch or commit gets the release matching its own version', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    makeInstallDir(home, '1.0.0');
    const { downloaded } = bootstrap(makeNpxSource('github:cglab-public/agenfk#beta', '2.0.0-beta.40'), home, archives, ['--beta']);
    onlyFetched(downloaded, 'v2.0.0-beta.40');
  });

  it('installs a pinned OLDER tag the user asked for, instead of keeping a newer dist over its source', () => {
    // Refusing here is what produced the mix: the pinned source was already
    // copied in, and only the dist was "protected".
    const home = mkdtempSync(path.join(work, 'home-'));
    const installDir = makeInstallDir(home, '9.9.9');
    const { downloaded } = bootstrap(makeNpxSource('github:cglab-public/agenfk#v2.0.0-beta.35', '2.0.0-beta.35'), home, archives);
    onlyFetched(downloaded, 'v2.0.0-beta.35');
    expect(existsSync(path.join(installDir, 'commands', 'from-v2.0.0-beta.35.md'))).toBe(true);
  });
});

describe('npx without a pin keeps tracking the channel', () => {
  it('downloads the newest release when no ref was requested', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    makeInstallDir(home, '1.0.0');
    const { downloaded } = bootstrap(makeNpxSource('github:cglab-public/agenfk', '1.0.0'), home, archives);
    onlyFetched(downloaded, LATEST);
  });
});

describe('a git clone without a built dist (#216)', () => {
  it('fetches the release matching its own version, not the newest', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const source = makeNpxSource(null, '2.0.0-beta.40');
    mkdirSync(path.join(source, '.git'));
    const { downloaded } = bootstrap(source, home, archives, ['--force-install']);
    onlyFetched(downloaded, 'v2.0.0-beta.40');
  });
});

describe('requested-ref helpers (#216)', () => {
  it('a release tag the user named wins over the version its source declares', async () => {
    const { releaseTagForRef } = await import('../../../../bin/requested-ref.mjs');
    expect(releaseTagForRef('v2.0.0-beta.35', '2.0.0-beta.34')).toBe('v2.0.0-beta.35');
  });

  it('a branch, commit or semver range takes the release of its source version', async () => {
    const { releaseTagForRef } = await import('../../../../bin/requested-ref.mjs');
    expect(releaseTagForRef('beta', '2.0.0-beta.40')).toBe('v2.0.0-beta.40');
    expect(releaseTagForRef('3b55163e', '2.0.0-beta.46')).toBe('v2.0.0-beta.46');
    expect(releaseTagForRef('semver:^2.0.0', '2.0.1')).toBe('v2.0.1');
    expect(releaseTagForRef('beta', null)).toBeNull();
  });

  it('reads nothing outside an npx cache layout', async () => {
    const { requestedGitRef } = await import('../../../../bin/requested-ref.mjs');
    const dir = mkdtempSync(path.join(work, 'not-npx-'));
    const pkgRoot = path.join(dir, 'some', 'agenfk');
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ _npx: { packages: ['github:cglab-public/agenfk#v1.0.0'] } }), 'utf8');
    expect(requestedGitRef(pkgRoot, require('fs'), path)).toBeNull();
  });
});

describe('pinned-ref hardening (#216 review)', () => {
  it('only a complete release tag counts as one: a v-prefixed branch takes the source version', async () => {
    const { releaseTagForRef } = await import('../../../../bin/requested-ref.mjs');
    expect(releaseTagForRef('v2-maintenance', '2.0.0-beta.40')).toBe('v2.0.0-beta.40');
    expect(releaseTagForRef('v2.0.0-beta.35/', '2.0.0-beta.35')).toBe('v2.0.0-beta.35');
  });

  it('never yields a tag that is not plain release syntax, whatever the ref or version holds', async () => {
    const { releaseTagForRef } = await import('../../../../bin/requested-ref.mjs');
    expect(releaseTagForRef('v1$(touch pwned)', '1.0.0')).toBe('v1.0.0');
    expect(releaseTagForRef('v1.0.0"; rm -rf ~; "', '1.0.0')).toBe('v1.0.0');
    expect(releaseTagForRef('beta', '1.0.0$(id)')).toBeNull();
  });

  it('matches only this repository, not one whose name merely contains it', async () => {
    const { requestedGitRef } = await import('../../../../bin/requested-ref.mjs');
    const cache = mkdtempSync(path.join(work, 'npx-multi-'));
    const root = path.join(cache, 'node_modules', 'agenfk');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(cache, 'package.json'), JSON.stringify({
      _npx: { packages: ['github:cglab-public/agenfk-tools#v1.0.0', 'github:cglab-public/agenfk'] },
      dependencies: { 'agenfk-tools': 'github:cglab-public/agenfk-tools#v1.0.0', agenfk: 'github:cglab-public/agenfk' },
    }), 'utf8');
    expect(requestedGitRef(root, require('fs'), path)).toBeNull();
  });

  it('accepts the other spellings npm records for this repository', async () => {
    const { requestedGitRef } = await import('../../../../bin/requested-ref.mjs');
    for (const spec of [
      'github:cglab-public/agenfk#v1.0.0',
      'cglab-public/agenfk#v1.0.0',
      'git+https://github.com/cglab-public/agenfk.git#v1.0.0',
      'git+ssh://git@github.com/CGLab-Public/agenfk.git#v1.0.0',
    ]) {
      const cache = mkdtempSync(path.join(work, 'npx-spell-'));
      const root = path.join(cache, 'node_modules', 'agenfk');
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(cache, 'package.json'), JSON.stringify({ _npx: { packages: [spec] } }), 'utf8');
      expect(requestedGitRef(root, require('fs'), path), spec).toBe('v1.0.0');
    }
  });

  it('a pinned update whose release cannot be downloaded fails, falls back to no other release, and leaves the install untouched', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const installDir = makeInstallDir(home, '1.0.0');
    const { r, downloaded } = bootstrap(makeNpxSource('github:cglab-public/agenfk#v3.0.0', '3.0.0'), home, archives);
    onlyFetched(downloaded, 'v3.0.0');
    for (const tag of TAGS) expect(existsSync(path.join(installDir, 'commands', `from-${tag}.md`))).toBe(false);
    expect(r.status).not.toBe(0);
    // Nothing of the pinned source was copied over the working install.
    expect(JSON.parse(readFileSync(path.join(installDir, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(existsSync(path.join(installDir, 'bin'))).toBe(false);
  });

  it('runs nothing smuggled in through the requested ref', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    makeInstallDir(home, '1.0.0');
    const marker = path.join(work, `pwned-${Math.random().toString(36).slice(2)}`);
    bootstrap(makeNpxSource(`github:cglab-public/agenfk#v1$(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')")`, '1.0.0'), home, archives);
    expect(existsSync(marker)).toBe(false);
  });

  it('a pinned archive that downloads but cannot be read fails before touching the install', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const installDir = makeInstallDir(home, '1.0.0');
    const { r, downloaded } = bootstrap(makeNpxSource(`github:cglab-public/agenfk#${CORRUPT}`, '4.0.0'), home, archives);
    onlyFetched(downloaded, CORRUPT);
    expect(r.status).not.toBe(0);
    expect(JSON.parse(readFileSync(path.join(installDir, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(existsSync(path.join(installDir, 'bin'))).toBe(false);
  });
});

describe('a git clone whose release cannot be downloaded (#216 review)', () => {
  it('falls back as before instead of crashing', () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const source = makeNpxSource(null, '5.0.0'); // no such release
    mkdirSync(path.join(source, '.git'));
    const { r, downloaded } = bootstrap(source, home, archives, ['--force-install']);
    onlyFetched(downloaded, 'v5.0.0');
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/Falling back to source-based installation/);
    expect(out).not.toMatch(/ReferenceError/);
  });
});
