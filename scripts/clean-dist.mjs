#!/usr/bin/env node
/**
 * Remove the current package's dist/ before it builds (d781db05).
 *
 * tsc emits into dist/ but never deletes the output of a source that was
 * removed, so a build on top of an old dist/ keeps shipping it - claims.js and
 * claimGate.js reached the desktop app's asar that way. Each package that
 * builds with tsc runs this as its `prebuild`, which npm runs for the root
 * build and for `npm run build -w <package>` alike.
 *
 * Only ever `<cwd>/dist`: npm runs a package's scripts from that package's
 * directory, and nothing here takes a path from the outside. A Dockerfile that
 * builds a package must COPY this script too.
 *
 * The cost: dist/ is absent for the whole tsc run rather than overwritten file
 * by file, so something reading it mid-build (a test, a CLI call from this
 * checkout) can miss it. Retries cover a file held briefly on Windows.
 */
import { rmSync } from 'fs';
import path from 'path';

rmSync(path.join(process.cwd(), 'dist'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
