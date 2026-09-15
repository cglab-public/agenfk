/**
 * Test config for hub-ui, kept OUT of vite.config.ts on purpose.
 *
 * Vitest prefers this file over vite.config.ts, so the production build never
 * loads it. That matters: this config imports a repo-root test helper, and
 * packages/hub/Dockerfile copies only packages/{core,flow-editor,brand,hub,
 * hub-ui} into the builder before running `npm run build -w packages/hub-ui`.
 * Putting the test block in vite.config.ts made the hub image fail to resolve
 * ../../scripts/vitest-shared-config.mjs — and only at `hub-v*` release time,
 * since hub-image.yml does not run on ordinary pushes.
 *
 * Why it exists at all: `npx vitest run` started from this directory used to
 * have no config, so it missed two things the root run supplies and produced 36
 * failures unrelated to the code under test —
 *   - setupFiles, so the root vitest.setup.ts shim never ran and `localStorage`
 *     stayed the undefined global Node installs over jsdom's;
 *   - globals: true, without which @testing-library never registers its
 *     automatic afterEach cleanup, so rendered trees accumulate and every
 *     getBy* reports "found multiple elements".
 *
 * `fileParallelism: true` matches what the root config gives this package: each
 * FILE in its own worker. Within-file concurrency stays off — these are React
 * component specs sharing one jsdom document, and running their tests
 * concurrently collides renders and fails 95 of them. The two used to be fused
 * under one flag, which is why neither could be enabled; see BUG c03aa92e.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sharedTest, sharedResolve } from '../../scripts/vitest-shared-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

export default defineConfig({
  plugins: [react()],
  // The same aliases and build-time defines the root config gives these specs.
  // Without them a spec importing @agenfk/core passes at root and fails here —
  // precisely the split this file exists to close.
  resolve: { alias: sharedResolve.alias },
  define: { __AGENFK_VERSION__: JSON.stringify('test') },
  test: {
    ...sharedTest({ include: ['src/test/**/*.{test,spec}.{ts,tsx}'], fileParallelism: true }),
    // Absolute: setupFiles resolve against THIS package, not the repo root.
    setupFiles: [path.join(REPO_ROOT, 'vitest.setup.ts')],
  },
});
