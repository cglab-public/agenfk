import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Tests for bin/agenfk-hub.js — the npx shim that bootstraps @agenfk/hub
// from a GitHub package install (no npm publish).
//
// Two bugs the patch addresses:
//   1) After tarball extraction (or initial cp of REPO_ROOT to ~/.agenfk-system),
//      hub runtime deps (cookie-parser, express, ...) were never installed,
//      so node packages/hub/dist/bin.js crashed with MODULE_NOT_FOUND.
//   2) When the downloaded tarball didn't include packages/hub/dist/bin.js
//      (e.g. user ran without --beta and got a pre-hub stable release),
//      the script bailed with a generic "binary not found" instead of
//      surfacing what actually went wrong.

const hubBinScript = readFileSync(
    path.resolve(__dirname, '../../../../bin/agenfk-hub.js'),
    'utf8'
);

describe('bin/agenfk-hub.js — runtime dep install', () => {
    it('runs npm install with --omit=dev to fetch hub runtime deps', () => {
        expect(hubBinScript).toMatch(/npm[^"']*install[^"']*--omit=dev/);
    });

    it('targets the hub workspace (or installs inside packages/hub)', () => {
        expect(hubBinScript).toMatch(/-w\s+packages\/hub|packages\/hub.*npm[^"']*install/s);
    });
});

describe('bin/agenfk-hub.js — missing-bin diagnostics', () => {
    it('verifies the hub bin exists after tarball extraction and reports a clear error if not', () => {
        // Either an explicit post-extract existsSync check around bin.js,
        // or a hint mentioning --beta when the tarball lacks the hub dist.
        expect(hubBinScript).toMatch(/--beta/);
        expect(hubBinScript).toMatch(/existsSync\([^)]*hub\/dist\/bin\.js[^)]*\)/);
    });
});
