// The hub-ui vitest config must not drift from the root one (BUG 8cddfdc2).
//
// hub-ui specs are run two ways: by CI through the root config (`npm test`), and
// by a developer iterating inside packages/hub-ui. Those two used to disagree —
// the local one had no test config at all, so it missed the localStorage shim
// and testing-library's automatic cleanup, and produced 36 failures that had
// nothing to do with the code under test. Someone reading that output reasonably
// concludes the board is red when it is green.
//
// These assert the settings that actually caused it, on the real resolved config
// rather than on the text of the file.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import viteConfig from '../../vite.config';
import { sharedTest } from '../../../../scripts/vitest-shared-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** The config export is a plain object here, but vite allows a function form. */
const resolved = (typeof viteConfig === 'function'
  ? (viteConfig as any)({ command: 'serve', mode: 'test' })
  : viteConfig) as any;

describe('hub-ui vitest config parity with the root run', () => {
  it('loads the setup file that repairs localStorage', () => {
    const setupFiles: string[] = resolved.test?.setupFiles ?? [];
    expect(setupFiles.length).toBeGreaterThan(0);
    // Resolves to a file that exists — a path that silently does not is the
    // same failure as having no setup at all.
    const shim = setupFiles.map(f => path.resolve(REPO_ROOT, f))
      .find(f => path.basename(f) === 'vitest.setup.ts');
    expect(shim, `setupFiles was ${JSON.stringify(setupFiles)}`).toBeTruthy();
    expect(fs.existsSync(shim!)).toBe(true);
  });

  it('enables globals, which is what registers testing-library cleanup', () => {
    // Without this @testing-library never installs its afterEach unmount, so
    // rendered trees accumulate across tests in a file and every getBy* throws
    // "found multiple elements".
    expect(resolved.test?.globals).toBe(true);
  });

  it('takes its settings from the same helper the root config uses', () => {
    // Parity by construction: whatever the root run changes about timeouts, env
    // or aliases arrives here too, rather than being copied and left behind.
    const shared = sharedTest({ include: ['src/test/**/*.{test,spec}.{ts,tsx}'] }) as any;
    expect(resolved.test.testTimeout).toBe(shared.testTimeout);
    expect(resolved.test.hookTimeout).toBe(shared.hookTimeout);
    expect(resolved.test.env).toEqual(shared.env);
  });

  it('keeps tests within a file serial, since they share one jsdom document', () => {
    // parallel: true would set sequence.concurrent and collide concurrent
    // renders — see the comment in vite.config.ts.
    expect(resolved.test.sequence?.concurrent).toBeFalsy();
  });
});
