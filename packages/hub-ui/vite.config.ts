// `vitest/config` re-exports vite's defineConfig widened to accept `test`.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sharedTest } from '../../scripts/vitest-shared-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

export default defineConfig({
  plugins: [react()],
  /**
   * Without this, `npx vitest run` started from THIS directory silently differs
   * from the root run that CI uses, and produces 36 failures that have nothing
   * to do with the code under test:
   *   - no setupFiles, so the root vitest.setup.ts shim never runs and
   *     `localStorage` stays the undefined global Node installs over jsdom's;
   *   - no `globals: true`, so @testing-library never registers its automatic
   *     afterEach cleanup, rendered trees pile up, and every getBy* reports
   *     "found multiple elements".
   * Both settings come from the same helper the root config uses, so the two
   * runs cannot drift. vitest-config-parity.test.ts holds that.
   *
   * Not `parallel: true`, unlike the root config's entry for this package: that
   * also sets `sequence.concurrent`, which runs tests WITHIN a file at the same
   * time. These are React component specs sharing one jsdom document, so two
   * concurrent renders collide and ~97 of them fail on "found multiple
   * elements". The root run does not hit this — `sequence.concurrent` does not
   * take effect from its per-project config — but relying on that here would be
   * relying on a quirk. 47 files run serially in about ten seconds.
   */
  test: {
    ...sharedTest({ include: ['src/test/**/*.{test,spec}.{ts,tsx}'] }),
    setupFiles: [path.join(REPO_ROOT, 'vitest.setup.ts')],
  },
  server: {
    port: parseInt(process.env.HUB_UI_PORT || '5180'),
    proxy: {
      '/v1': 'http://localhost:4000',
      '/auth': 'http://localhost:4000',
      '/setup': 'http://localhost:4000',
      '/healthz': 'http://localhost:4000',
    },
  },
});
