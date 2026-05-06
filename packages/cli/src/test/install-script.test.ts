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

const uninstallScript = readFileSync(
    path.resolve(__dirname, '../../../../scripts/uninstall.mjs'),
    'utf8'
);

const bootstrapScript = readFileSync(
    path.resolve(__dirname, '../../../../bin/agenfk.js'),
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
// bin/agenfk.js — --beta flag (task ece8514b)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// bin/agenfk.js — Downgrade guard
// `npx github:cglab-public/agenfk` (no --beta) on an existing prerelease
// install used to fetch /releases/latest (which excludes prereleases),
// resolve to v0.2.28, and tar -xzf over the install — silently downgrading
// any beta installation. The bootstrap must refuse to extract any tag whose
// version is older than the existing install's package.json.
// ---------------------------------------------------------------------------
describe('bin/agenfk.js — refuses to downgrade an existing install', () => {
    it('reads the existing install\'s package.json before deciding to extract', () => {
        // Must read INSTALL_DIR/package.json to know the local version.
        expect(bootstrapScript).toMatch(/readLocalVersion\(\s*INSTALL_DIR\s*\)|readFileSync\([^)]*['"]package\.json['"]/);
        expect(bootstrapScript).toMatch(/INSTALL_DIR/);
    });

    it('compares resolved tag against local version and skips extraction when local is newer', () => {
        // A semver-aware comparison gating the tar -xzf call.
        expect(bootstrapScript).toMatch(/compareSemver|compareVersion|isOlder|localIsNewer|isDowngrade/i);
    });

    it('logs a clear skip message when refusing to downgrade', () => {
        // User-visible feedback so this isn't silent.
        expect(bootstrapScript).toMatch(/skip.*downgrade|local.*newer|refus.*downgrade|already on a newer/i);
    });
});

describe('bin/agenfk.js — --beta flag for npx beta installs', () => {
    it('detects --beta flag from process.argv', () => {
        // The bootstrap must check process.argv for --beta
        expect(bootstrapScript).toMatch(/argv.*beta|beta.*argv/i);
    });

    it('uses /releases?per_page= endpoint when beta flag is set', () => {
        // Beta installs fetch all releases and pick the latest by date,
        // not /releases/latest which excludes pre-releases.
        expect(bootstrapScript).toMatch(/releases\?per_page=/);
    });

    it('forwards --beta flag to scripts/install.mjs', () => {
        // install.mjs is invoked via execSync — the --beta flag must be forwarded
        // so downstream steps know this is a beta install.
        expect(bootstrapScript).toMatch(/install\.mjs.*beta|beta.*install\.mjs/);
    });
});

// ---------------------------------------------------------------------------
// bin/agenfk.js + install.mjs — Windows tar --force-local (bug 7c938419)
// ---------------------------------------------------------------------------
describe('bin/agenfk.js — Windows tar --force-local', () => {
    it('uses --force-local when extracting tar on Windows', () => {
        // BSD tar (Windows built-in) treats "C:" in paths as a remote hostname.
        // --force-local disables that behaviour.
        expect(bootstrapScript).toContain('--force-local');
    });

    it('--force-local is gated to win32 platform', () => {
        // Should not add the flag on Linux/macOS where GNU tar handles it fine.
        const forceLocalIdx = bootstrapScript.indexOf('--force-local');
        expect(forceLocalIdx).toBeGreaterThan(-1);
        const before = bootstrapScript.slice(0, forceLocalIdx);
        expect(before).toMatch(/win32/);
    });
});

describe('install.mjs — Windows tar --force-local', () => {
    it('uses --force-local when extracting tar on Windows', () => {
        expect(installScript).toContain('--force-local');
    });

    it('--force-local is gated to win32 platform', () => {
        const forceLocalIdx = installScript.indexOf('--force-local');
        expect(forceLocalIdx).toBeGreaterThan(-1);
        const before = installScript.slice(0, forceLocalIdx);
        expect(before).toMatch(/win32/);
    });
});

// ---------------------------------------------------------------------------
// MCP server + CLI — validate_progress 5-minute timeout (task 9c5d2fbe)
// ---------------------------------------------------------------------------
const mcpServerScript = readFileSync(
    path.resolve(__dirname, '../../../server/src/index.ts'),
    'utf8'
);

const cliScript = readFileSync(
    path.resolve(__dirname, '../../src/index.ts'),
    'utf8'
);

describe('MCP server — validate_progress uses 5-minute timeout', () => {
    it('validate_progress post call has a 300000ms timeout', () => {
        // 30s is too short for npm run build && npm test; must be 5 minutes.
        const validateIdx = mcpServerScript.indexOf('case "validate_progress"');
        expect(validateIdx).toBeGreaterThan(-1);
        const block = mcpServerScript.slice(validateIdx, validateIdx + 500);
        expect(block).toMatch(/300000/);
    });

    it('review_changes post call has a 300000ms timeout', () => {
        const idx = mcpServerScript.indexOf('case "review_changes"');
        expect(idx).toBeGreaterThan(-1);
        const block = mcpServerScript.slice(idx, idx + 400);
        expect(block).toMatch(/300000/);
    });

    it('test_changes post call has a 300000ms timeout', () => {
        const idx = mcpServerScript.indexOf('case "test_changes"');
        expect(idx).toBeGreaterThan(-1);
        const block = mcpServerScript.slice(idx, idx + 400);
        expect(block).toMatch(/300000/);
    });
});

describe('CLI — agenfk verify uses 5-minute timeout', () => {
    it('verify command axios.post has a 300000ms timeout', () => {
        // The verify command calls /items/:id/validate — must not time out on long builds.
        const verifyIdx = cliScript.indexOf(".command('verify");
        expect(verifyIdx).toBeGreaterThan(-1);
        const block = cliScript.slice(verifyIdx, verifyIdx + 2000);
        expect(block).toMatch(/300000/);
    });
});

// ---------------------------------------------------------------------------
// install.mjs — npm spawnSync must use shell:true on Windows (bug acb7232c)
// On MinGW, spawnSync('npm') without shell:true fails to find npm.cmd,
// silently skipping npm ci and leaving node_modules empty.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// install.mjs template + start-services.mjs — npm spawn shell:true (bug 47c80eec)
// spawn(npmCmd, ['run', 'preview']) without shell:true fails with ENOENT on MinGW
// because npm is a .cmd script that requires cmd.exe to execute.
// ---------------------------------------------------------------------------
const startServicesScript = readFileSync(
    path.resolve(__dirname, '../../../../scripts/start-services.mjs'),
    'utf8'
);

describe('start-services.mjs — npm spawn uses shell:true on Windows', () => {
    it('passes shell option to the npm run preview spawn call', () => {
        const spawnIdx = startServicesScript.indexOf("spawn(npmCmd, ['run', 'preview']");
        expect(spawnIdx).toBeGreaterThan(-1);
        const spawnBlock = startServicesScript.slice(spawnIdx, spawnIdx + 400);
        expect(spawnBlock).toMatch(/shell/);
    });

    it('gates shell:true to win32 only in start-services', () => {
        const spawnIdx = startServicesScript.indexOf("spawn(npmCmd, ['run', 'preview']");
        const spawnBlock = startServicesScript.slice(spawnIdx, spawnIdx + 400);
        expect(spawnBlock).toMatch(/win32/);
    });
});

describe('install.mjs template — npm spawn uses shell:true on Windows', () => {
    it('template passes shell option to the npm run preview spawn call', () => {
        // The template written to start-services.mjs must include shell on the spawn
        const templateStart = installScript.indexOf("spawn(npmCmd, ['run', 'preview']");
        expect(templateStart).toBeGreaterThan(-1);
        const templateBlock = installScript.slice(templateStart, templateStart + 400);
        expect(templateBlock).toMatch(/shell/);
    });

    it('template gates shell:true to win32 only', () => {
        const templateStart = installScript.indexOf("spawn(npmCmd, ['run', 'preview']");
        const templateBlock = installScript.slice(templateStart, templateStart + 400);
        expect(templateBlock).toMatch(/win32/);
    });
});

describe('install.mjs — npm spawnSync uses shell:true on Windows', () => {
    it('passes shell option to the npm ci spawnSync call', () => {
        // The spawnSync for npm ci must include a shell option so .cmd scripts
        // are resolved on Windows (both MinGW and native cmd.exe).
        // Match the assignment: const npmCiResult = spawnSync(...)
        const assignIdx = installScript.indexOf('npmCiResult = spawnSync');
        expect(assignIdx).toBeGreaterThan(-1);
        // Grab from the assignment to closing brace of the options object
        const spawnBlock = installScript.slice(assignIdx, assignIdx + 300);
        expect(spawnBlock).toMatch(/shell/);
    });

    it('gates shell:true to win32 only — not forced on Linux/macOS', () => {
        // shell:true on Linux spawns an extra process for no reason.
        // Must be conditional on win32.
        const assignIdx = installScript.indexOf('npmCiResult = spawnSync');
        const spawnBlock = installScript.slice(assignIdx, assignIdx + 300);
        expect(spawnBlock).toMatch(/win32/);
    });
});
