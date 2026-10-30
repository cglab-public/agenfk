#!/usr/bin/env node
/**
 * Bundle the Airlock exec helper for packaging (ea94c023).
 *
 * The packaged app has no agenfk CLI beside its server, and its Node is
 * Electron. For a card an Airlock sandbox touched, the server runs this helper
 * (`ELECTRON_RUN_AS_NODE=1 <app> agenfk-airlock-exec.cjs airlock exec ...`) to
 * run the card's commands inside the sandbox.
 *
 * Everything is bundled into one ES module, the Sandbox Runtime and its
 * dependencies included: electron-builder leaves node_modules out of a packaged
 * resource whatever the filter says (measured), so the runtime cannot ship as
 * its package. It finds its vendored helpers (Linux's seccomp filter) from its
 * own file's location - `<dir of the file>/../vendor` is one of the places it
 * looks - so the bundle lives in dist/ and the runtime's vendor/ is copied
 * beside it. The CLI code is CommonJS; the banner gives it require, __dirname
 * and __filename in the module.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const ASRT = '@anthropic-ai/sandbox-runtime';

const entry = path.join(repoRoot, 'packages/cli/dist/airlock/execMain.js');
const outdir = path.join(desktopDir, 'build/airlock');
const outfile = path.join(outdir, 'dist', 'agenfk-airlock-exec.mjs');

if (!fs.existsSync(entry)) {
  console.error(`[bundle-airlock] ${entry} not found - run \`npm run build\` at the repo root first.`);
  process.exit(1);
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile,
  metafile: true,
  // so the metafile's input paths are relative to the repo, wherever the script runs from
  absWorkingDir: repoRoot,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'bundle',
  external: ['electron'],
  // The helper has no package.json beside it: its version names the base image of its machine.
  define: { __AGENFK_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')).version) },
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
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

// The runtime's vendored helpers, where it looks for them from dist/.
const asrtDir = path.dirname(createRequire(path.join(repoRoot, 'packages/cli/noop.js')).resolve(`${ASRT}/package.json`));
fs.cpSync(path.join(asrtDir, 'vendor'), path.join(outdir, 'vendor'), { recursive: true, dereference: true });
// Which runtime this is, for the packaging test and for anyone reading the app's resources.
fs.writeFileSync(path.join(outdir, 'sandbox-runtime.json'), JSON.stringify({ name: ASRT, version: JSON.parse(fs.readFileSync(path.join(asrtDir, 'package.json'), 'utf8')).version }) + '\n');

// The licence notices of every third-party package the bundle inlines (they ship with it).
const pkgDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
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
fs.writeFileSync(
  path.join(outdir, 'THIRD_PARTY_NOTICES.txt'),
  `Third-party software inlined in dist/agenfk-airlock-exec.mjs and the vendor/ directory beside it.\n\n${notices.join('\n\n' + '-'.repeat(72) + '\n\n')}\n`,
);

const size = fs.statSync(outfile).size;
console.log(`[bundle-airlock] wrote ${path.relative(repoRoot, outfile)} (${Math.round(size / 1024)} KB), the runtime's vendor/ and the notices of ${pkgDirs.size} packages`);
