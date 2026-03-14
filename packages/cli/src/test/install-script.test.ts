import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const bootstrapScript = readFileSync(
    path.resolve(__dirname, '../../../../bin/agenfk.js'),
    'utf8'
);

// Tests for the install.mjs script's production dependency installation.
// Root cause: tsc compiles CLI to dist/ without bundling — dist/index.js
// still requires 'commander' at runtime, but node_modules is NOT included
// in agenfk-dist.tar.gz and install.mjs never runs npm install.
// Fix: install.mjs must run `npm ci --omit=dev` after dist verification.

const installScript = readFileSync(
    path.resolve(__dirname, '../../../../scripts/install.mjs'),
    'utf8'
);

const uninstallScript = readFileSync(
    path.resolve(__dirname, '../../../../scripts/uninstall.mjs'),
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

// ---------------------------------------------------------------------------
// uninstall.mjs — step 3b respects --only=<platform> flag
// ---------------------------------------------------------------------------
describe('uninstall.mjs — step 3b skills removal respects --only flag', () => {
    it('step 3b must reference onlyPlatform to gate per-platform skills removal', () => {
        // Extract the 3b block: from "3b." to "3c." or "// 4."
        const start3b = uninstallScript.indexOf('3b.');
        const end3b = uninstallScript.indexOf('// 4.', start3b);
        expect(start3b).toBeGreaterThan(-1);
        const block3b = uninstallScript.slice(start3b, end3b > -1 ? end3b : start3b + 2000);
        // The block must reference onlyPlatform so it can filter by platform
        expect(block3b).toMatch(/onlyPlatform|shouldRun|only.*platform/i);
    });

    it('step 3b defines a platform-to-skills-dir mapping', () => {
        // After fix, each platform should map to its own skills dir
        // e.g. claude → .claude/skills, opencode → .config/opencode/skills, etc.
        const start3b = uninstallScript.indexOf('3b.');
        const block3b = uninstallScript.slice(start3b, start3b + 2000);
        // All platform-specific dirs must be present
        expect(block3b).toMatch(/\.claude.*skills|claude.*\.claude/i);
        expect(block3b).toMatch(/opencode.*skills|config.*opencode/i);
        expect(block3b).toMatch(/cursor.*skills/i);
        expect(block3b).toMatch(/codex.*skills/i);
        expect(block3b).toMatch(/gemini.*skills/i);
    });

    it('step 3b only removes .agents/skills when no specific platform is targeted', () => {
        // .agents/skills is a universal dir — should not be wiped for a single-platform pause
        const start3b = uninstallScript.indexOf('3b.');
        const block3b = uninstallScript.slice(start3b, start3b + 2000);
        // The .agents/skills removal must be guarded by !onlyPlatform or similar
        const agentsIdx = block3b.indexOf('.agents');
        expect(agentsIdx).toBeGreaterThan(-1);
        // Ensure there's a conditional referencing onlyPlatform before .agents removal
        // (either !onlyPlatform or a ternary where .agents is in the falsy branch)
        const beforeAgents = block3b.slice(0, agentsIdx);
        expect(beforeAgents).toMatch(/onlyPlatform/i);
    });
});

// ---------------------------------------------------------------------------
// install.mjs — Windows native PATH setup (task ca1dd7d8)
// ---------------------------------------------------------------------------
describe('install.mjs — Windows native PATH setup', () => {
    it('uses LOCALAPPDATA-based bin dir on Windows', () => {
        // On native Windows, ~/.local/bin is not a standard location.
        // The installer must use %LOCALAPPDATA%\agenfk\bin instead.
        expect(installScript).toMatch(/LOCALAPPDATA/);
    });

    it('LOCALAPPDATA bin dir path includes agenfk subdirectory', () => {
        // Must be scoped under an agenfk sub-folder, not placed directly in AppData root.
        expect(installScript).toMatch(/LOCALAPPDATA[^'"]*agenfk/i);
    });

    it('updates Windows User PATH after installing CLI', () => {
        // On Windows, the installer must persist the bin dir to the User PATH so
        // 'agenfk' is discoverable in new terminal sessions without manual steps.
        // PowerShell [Environment]::SetEnvironmentVariable is the correct API —
        // setx is limited to 1024 chars and silently truncates long PATHs.
        expect(installScript).toMatch(/SetEnvironmentVariable/);
    });

    it('Windows PATH update targets User scope, not Machine scope', () => {
        // Machine scope requires admin elevation; User scope does not.
        expect(installScript).toMatch(/SetEnvironmentVariable[^)]*User/);
    });

    it('Windows PATH update is guarded so it only runs on win32', () => {
        // The SetEnvironmentVariable call must be inside a win32 platform check.
        const winIdx = installScript.indexOf('SetEnvironmentVariable');
        expect(winIdx).toBeGreaterThan(-1);
        // Search backwards for the nearest platform guard
        const before = installScript.slice(0, winIdx);
        expect(before).toMatch(/win32/);
    });

    it('shows a completion message on Windows', () => {
        // bin/agenfk.js currently only prints the "installation complete" message
        // on non-win32. It must also print something useful on Windows.
        // Simplest fix: remove the platform guard so the message is always shown.
        const winCompletionIdx = bootstrapScript.search(/agenfk up|installation complete/i);
        expect(winCompletionIdx).toBeGreaterThan(-1);
        // The message must NOT be inside an `if (process.platform !== 'win32')` block
        // i.e. the entire message block should not be gated to non-windows only.
        // We verify this by checking there's no win32 exclusion wrapping the message.
        const msgMatch = bootstrapScript.match(/if\s*\(\s*process\.platform\s*!==\s*['"]win32['"]\s*\)/g);
        // If there IS a non-win32 guard, the agenfk-up message must also appear outside it
        if (msgMatch) {
            // Find where the guard ends and check the message appears after (outside) the block too
            const guardIdx = bootstrapScript.indexOf("process.platform !== 'win32'");
            const afterGuard = bootstrapScript.slice(guardIdx + 200); // skip past the block body
            // Either: message appears after the guard block, OR the guard was removed
            const messageOutsideGuard = /agenfk up|installation complete/i.test(afterGuard);
            const guardRemoved = guardIdx === -1;
            expect(messageOutsideGuard || guardRemoved).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// bin/agenfk.js — Windows compatibility (task 55f052b9)
// ---------------------------------------------------------------------------
describe('bin/agenfk.js — no bash fallback on Windows', () => {
    it('does not fall back to cp -r shell command', () => {
        // cp -r is a bash command unavailable in native Windows PowerShell/cmd.
        // fs.cpSync (Node 16.7+) handles the copy without a shell, so the bash
        // fallback must be removed.
        expect(bootstrapScript).not.toContain('cp -r');
    });
});
