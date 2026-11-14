#!/usr/bin/env node
/**
 * Bundle the preload into one file (CGLAB f2fa8fc4 regression).
 *
 * The renderer runs with `sandbox: true`, and a SANDBOXED PRELOAD CANNOT
 * `require` a local file. It gets a small allowlist — `electron` and a few
 * polyfilled builtins — and nothing else. So the preload has to arrive as a
 * single file, however many modules it is written as.
 *
 * This was learned the hard way. Splitting the session demux into its own
 * module was right for testing and broke the packaged app completely: the
 * `require('./sessionDemux.js')` threw, `contextBridge.exposeInMainWorld` never
 * ran, `window.agenfkDesktop` never appeared, and the renderer's `isDesktop()`
 * answered false. The app then fell back to the BROWSER shell — a bare Kanban
 * board with no sidebar, no tabs and no terminal — which looks like a version
 * that was never built rather than like a broken bridge.
 *
 * Nothing in the test suite could see it: the modules are correct, the types
 * are correct, and the file was present in the asar. Only running the packaged
 * app shows it.
 *
 * Same reasoning as bundle-server.mjs, and the same tool.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import * as path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');

await build({
  entryPoints: [path.join(pkg, 'dist/preload/index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron's own module, always resolved at runtime and never bundled.
  external: ['electron'],
  // Overwrites the entry point itself: the main process points at this exact
  // path, and a second filename would mean two places to keep in step.
  outfile: path.join(pkg, 'dist/preload/index.js'),
  allowOverwrite: true,
});

console.log('[preload] bundled dist/preload/index.js');
