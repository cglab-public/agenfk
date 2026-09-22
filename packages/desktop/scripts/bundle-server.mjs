#!/usr/bin/env node
/**
 * Bundle the AgEnFK server for packaging (CGLAB-171).
 *
 * The desktop app forks `packages/server/dist/server.js` as a child process.
 * In the monorepo that file's dependencies — express, socket.io, axios — are
 * hoisted into the ROOT node_modules, so it runs fine on a dev machine. A
 * packaged .app has no such tree: shipping `dist/` alone gets you `Cannot find
 * module 'express'` the moment the app launches, and nothing in the ordinary
 * test run notices.
 *
 * Shipping the dependency closure instead would mean pruning a hoisted
 * workspace tree at build time — fragile, and it drags devDependencies along.
 * Bundling produces one self-contained file whose contents are decided at build
 * time rather than at install time.
 *
 * Node builtins stay external on purpose. `node:sqlite` in particular must come
 * from Electron's own Node (24.15), which is what makes storage work with no
 * native module to rebuild.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '../..');

const entry = path.join(repoRoot, 'packages/server/dist/server.js');
const outdir = path.join(desktopDir, 'build/server-bundle');

if (!fs.existsSync(entry)) {
  console.error(`[bundle-server] ${entry} not found — run \`npm run build\` at the repo root first.`);
  process.exit(1);
}

fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: path.join(outdir, 'server.js'),
  bundle: true,
  platform: 'node',
  // Electron 40 ships Node 24; targeting it avoids needless down-levelling of
  // syntax the runtime supports natively.
  target: 'node22',
  format: 'cjs',
  // Builtins only. Everything else is inlined, which is the entire point.
  packages: 'bundle',
  external: ['electron'],
  // Keep it readable: this file is what a user's crash report will quote.
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

const size = fs.statSync(path.join(outdir, 'server.js')).size;
console.log(`[bundle-server] wrote ${path.relative(repoRoot, path.join(outdir, 'server.js'))} (${Math.round(size / 1024)} KB)`);
