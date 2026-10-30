#!/usr/bin/env node
/**
 * Bundle the Airlock exec helper for packaging (ea94c023, CGLAB-696).
 *
 * The packaged app has no agenfk CLI beside its server, and its Node is
 * Electron. For a card an Airlock sandbox touched, the server runs this helper
 * (`ELECTRON_RUN_AS_NODE=1 <app> agenfk-airlock-exec.mjs airlock exec ...`) to
 * run the card's commands in the workspace's smolvm machine.
 *
 * Two things go in build/airlock:
 *  - dist/agenfk-airlock-exec.mjs: the helper, one ES module with everything it
 *    needs inlined (electron-builder leaves node_modules out of a packaged
 *    resource whatever the filter says - measured). The CLI code is CommonJS;
 *    the banner gives it require, __dirname and __filename in the module.
 *  - dist/egressMain.js: the egress decider a machine is started with, which the
 *    helper spawns from its own directory (startEgressHelper).
 * And build/airlock-smolvm/<os>-<arch>: the pinned smolvm release for each
 * architecture packaged for this OS, checked against the sha256 the CLI records
 * (smolvmInstall.ts); electron-builder puts the artifact's own beside the helper
 * (airlock/smolvm), which is what it runs (smolvmPathFor). Empty where smolvm
 * does not run. Set AGENFK_SMOLVM_OS (mac, linux, win) to bundle another OS's.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const require = createRequire(import.meta.url);

const entry = path.join(repoRoot, 'packages/cli/dist/airlock/execMain.js');
const egressEntry = path.join(repoRoot, 'packages/cli/dist/airlock/egressMain.js');
const outdir = path.join(desktopDir, 'build/airlock');
const outfile = path.join(outdir, 'dist', 'agenfk-airlock-exec.mjs');
// Downloads are kept between runs (verified again every time): the release is ~40 MB.
const cacheDir = path.join(desktopDir, 'build/airlock-cache');
const smolvmOut = path.join(desktopDir, 'build/airlock-smolvm');

for (const f of [entry, egressEntry]) {
  if (!fs.existsSync(f)) {
    console.error(`[bundle-airlock] ${f} not found - run \`npm run build\` at the repo root first.`);
    process.exit(1);
  }
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')).version;
const common = {
  // so the metafile's input paths are relative to the repo, wherever the script runs from
  absWorkingDir: repoRoot,
  bundle: true,
  platform: 'node',
  target: 'node22',
  packages: 'bundle',
  external: ['electron'],
  metafile: true,
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
};

const result = await build({
  ...common,
  entryPoints: [entry],
  outfile,
  format: 'esm',
  // The helper has no package.json beside it: its version names the base image of its machine.
  define: { __AGENFK_VERSION__: JSON.stringify(version) },
  banner: {
    js: [
      "import { createRequire as __agenfkCreateRequire } from 'module';",
      "import { fileURLToPath as __agenfkFileURLToPath } from 'url';",
      "import { dirname as __agenfkDirname } from 'path';",
      'const require = __agenfkCreateRequire(import.meta.url);',
      'const __filename = __agenfkFileURLToPath(import.meta.url);',
      'const __dirname = __agenfkDirname(__filename);',
    ].join('\n'),
  },
});
// CommonJS, as the CLI builds it: it runs itself when it is the main module.
const egress = await build({ ...common, entryPoints: [egressEntry], outfile: path.join(outdir, 'dist', 'egressMain.js'), format: 'cjs' });

// The pinned smolvm, one directory per architecture electron-builder packages for this OS
// (build/airlock-smolvm/${os}-${arch}, picked per artifact by electron-builder.config.cjs).
// Each exists, empty where smolvm does not run (Intel Macs, Windows), so packaging never
// fails on a missing source.
const { SMOLVM_RELEASES } = require(path.join(repoRoot, 'packages/cli/dist/airlock/smolvmInstall.js'));
const { SMOLVM_VERSION } = require(path.join(repoRoot, 'packages/cli/dist/airlock/smolvm.js'));
const BUILDER_OS = { darwin: 'mac', linux: 'linux', win32: 'win' };
const NODE_PLATFORM = { mac: 'darwin', linux: 'linux', win: 'win32' };
const builderOs = process.env.AGENFK_SMOLVM_OS || BUILDER_OS[process.platform];
const platform = NODE_PLATFORM[builderOs];
if (!platform) throw new Error(`[bundle-airlock] unknown OS ${builderOs}`);
fs.rmSync(smolvmOut, { recursive: true, force: true });
const bundled = [];
for (const arch of ['x64', 'arm64']) {
  const dest = path.join(smolvmOut, `${builderOs}-${arch}`);
  fs.mkdirSync(dest, { recursive: true });
  const release = SMOLVM_RELEASES[`${platform}-${arch}`];
  if (!release) {
    fs.writeFileSync(path.join(dest, 'NO-SMOLVM.txt'), `smolvm does not run on ${platform}-${arch}: the app's Airlock cannot run commands there.\n`);
    continue;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, path.basename(new URL(release.url).pathname));
  const sum = () => crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (!fs.existsSync(archive) || sum() !== release.sha256) {
    const res = await fetch(release.url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
    if (!res.ok) throw new Error(`[bundle-airlock] downloading ${release.url}: HTTP ${res.status}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
  const got = sum();
  if (got !== release.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`[bundle-airlock] ${release.url} has sha256 ${got}, not the ${release.sha256} the CLI records: not bundled.`);
  }
  const tar = spawnSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { encoding: 'utf8', windowsHide: true });
  if (tar.status !== 0) throw new Error(`[bundle-airlock] unpacking ${archive}: ${tar.stderr}`);
  fs.writeFileSync(path.join(dest, 'smolvm.json'), JSON.stringify({ name: 'smolvm', version: SMOLVM_VERSION, platform: `${platform}-${arch}` }) + '\n');
  bundled.push(`${platform}-${arch}`);
}
const smolvmNotice = bundled.length
  ? `smolvm@${SMOLVM_VERSION}  (Apache-2.0)\n\nsmolvm (https://github.com/smol-machines/smolvm), its release ${SMOLVM_VERSION} (${bundled.join(', ')}), in smolvm/, is licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0`
  : null;

// The licence notices of every third-party package the bundles inline (they ship with them).
const pkgDirs = new Set();
for (const input of [...Object.keys(result.metafile.inputs), ...Object.keys(egress.metafile.inputs)]) {
  const abs = path.resolve(repoRoot, input);
  const parts = abs.split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) continue;
  const scoped = parts[at + 1]?.startsWith('@');
  pkgDirs.add(parts.slice(0, at + (scoped ? 3 : 2)).join(path.sep));
}
const notices = [];
for (const dir of [...pkgDirs].sort()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
  const texts = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
  notices.push([
    `${pkg.name}@${pkg.version}  (${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'see package')})`,
    ...(texts.length ? texts : [`No licence file in the package; its package.json says: ${JSON.stringify(pkg.license ?? null)}.`]),
  ].join('\n\n'));
}
if (smolvmNotice) notices.push(smolvmNotice);
fs.writeFileSync(
  path.join(outdir, 'THIRD_PARTY_NOTICES.txt'),
  `Third-party software inlined in dist/ and bundled in smolvm/.\n\n${notices.join('\n\n' + '-'.repeat(72) + '\n\n')}\n`,
);

const size = fs.statSync(outfile).size;
console.log(`[bundle-airlock] wrote ${path.relative(repoRoot, outfile)} (${Math.round(size / 1024)} KB), dist/egressMain.js, ${bundled.length ? `smolvm ${SMOLVM_VERSION} (${bundled.join(', ')})` : 'no smolvm'} and the notices of ${pkgDirs.size} packages`);
