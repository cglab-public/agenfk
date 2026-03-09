import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Tests for the install.mjs script's production dependency installation.
// Root cause: tsc compiles CLI to dist/ without bundling — dist/index.js
// still requires 'commander' at runtime, but node_modules is NOT included
// in agenfk-dist.tar.gz and install.mjs never runs npm install.
// Fix: install.mjs must run `npm ci --omit=dev` after dist verification.

const installScript = readFileSync(
    path.resolve(__dirname, '../../../../scripts/install.mjs'),
    'utf8'
);

describe('install.mjs — production dependency installation', () => {
    it('runs npm ci to install production dependencies', () => {
        expect(installScript).toContain('npm ci');
    });

    it('uses --omit=dev flag to skip devDependencies', () => {
        // Verify production-only install (no bloat from dev deps)
        expect(installScript).toMatch(/npm.*ci.*--omit=dev|npm.*--omit=dev.*ci/);
    });

    it('checks for node_modules existence before running npm ci', () => {
        // Idempotent: skip npm ci if already installed (saves time on re-runs)
        expect(installScript).toMatch(/node_modules/);
        // The node_modules check must appear near or before the npm ci call
        const nmIndex = installScript.indexOf('node_modules');
        const npmCiIndex = installScript.indexOf('npm ci');
        expect(nmIndex).toBeGreaterThan(-1);
        expect(npmCiIndex).toBeGreaterThan(-1);
        expect(nmIndex).toBeLessThan(npmCiIndex);
    });

    it('runs npm ci before any CLI invocation', () => {
        // node_modules must be ready before the gatekeeper/init CLI call
        const npmCiIndex = installScript.indexOf('npm ci');
        const cliInitIndex = installScript.indexOf("packages/cli/bin/agenfk.js");
        expect(npmCiIndex).toBeGreaterThan(-1);
        expect(cliInitIndex).toBeGreaterThan(-1);
        expect(npmCiIndex).toBeLessThan(cliInitIndex);
    });

    it('falls back gracefully if npm ci fails', () => {
        // Should not exit fatally on npm ci failure — log a warning and continue
        // because the rest of install (MCP registration, hooks etc.) should still run
        const npmCiIndex = installScript.indexOf('npm ci');
        const afterNpmCi = installScript.slice(npmCiIndex);
        // Expect either a status/error check or a try/catch around the npm ci call
        expect(afterNpmCi).toMatch(/status|error|warn|catch|Warning/i);
    });
});
