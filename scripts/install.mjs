import fs from 'fs/promises';
import { existsSync, chmodSync, writeFileSync, readdirSync, copyFileSync, readFileSync, renameSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, execSync } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { resolveRulesScope, shellSourceHint, buildCodexHooksConfig, shouldRegisterCodexMcp, isInstallableMarkdown, isMacMetadata, isAgenfkOwnedEntry } from './install-helpers.mjs';

const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const agenfkHome = path.join(os.homedir(), '.agenfk');

const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX || (os.platform() === 'win32' && process.env.SHELL?.includes('bash')));

function getCliCommand(name) {
    return os.platform() === 'win32' && !isMinGW ? `${name}.cmd` : name;
}

// Returns the platform-appropriate path for Cursor's global mcp.json.
function getCursorMcpPath() {
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Cursor', 'mcp.json');
    } else if (os.platform() === 'darwin') {
        return path.join(os.homedir(), '.cursor', 'mcp.json');
    } else {
        return path.join(os.homedir(), '.config', 'cursor', 'mcp.json');
    }
}

// Converts a MinGW POSIX path (/c/Users/...) to a Win32 path (C:\Users\...)
// so that native Windows apps (like Cursor) can resolve it correctly.
function toWindowsPath(p) {
    if (isMinGW && /^\/[a-zA-Z]\//.test(p)) {
        return p[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\');
    }
    return p;
}

// Converts a Win32 drive path (C:\Users\...) to an MSYS2 POSIX path (/c/Users/...)
// so that MSYS2 tar never sees a bare "C:" that it might interpret as a remote hostname.
function toPosixPath(p) {
    if (isMinGW && /^[a-zA-Z]:/.test(p)) {
        return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
    }
    return p;
}

// Returns the platform-appropriate directory for Cursor's global rules (.mdc files).
function getCursorRulesDir() {
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Cursor', 'rules');
    } else if (os.platform() === 'darwin') {
        return path.join(os.homedir(), '.cursor', 'rules');
    } else {
        return path.join(os.homedir(), '.config', 'cursor', 'rules');
    }
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function run() {
    console.log(`${BLUE}=== AgenFK Framework Installation ===${NC}`);

    const debuglog = process.argv.includes('--debuglog');
    const onlyPlatform = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1];
    const skipPlatform = process.argv.find(arg => arg.startsWith('--skip='))?.split('=')[1];
    const rulesScopeArg = process.argv.find(arg => arg.startsWith('--rules-scope='))?.split('=')[1];
    const rulesOnly = process.argv.includes('--rules-only');
    // MCP is opt-in: AgenFK is CLI-only by default. `--with-mcp` registers the
    // agenfk MCP server with each detected client; `--no-mcp` force-disables it.
    // The resolved preference is persisted in ~/.agenfk/config.json so that
    // re-installs (e.g. via `agenfk resume` / `agenfk integration install`)
    // honor a prior opt-in without re-passing the flag.
    const withMcpArg = process.argv.includes('--with-mcp');
    const noMcpArg = process.argv.includes('--no-mcp');
    // When installing project-scoped rules via `agenfk rules install`, the target
    // project is the user's current working directory, not the framework install dir.
    const projectDir = rulesOnly ? process.cwd() : rootDir;

    const debugLog = debuglog ? (...args) => console.log(`${YELLOW}[DEBUG]${NC}`, ...args) : () => {};

    // BUG 174270e6: capture whether an API server was already running before
    // we replace files on disk. If it was, we must restart it at the end so
    // it picks up the new code instead of executing the now-stale process image.
    let wasReachableBeforeInstall = false;
    let preInstallServerPort = process.env.AGENFK_PORT || '3000';

    if (debuglog) {
        debugLog('=== AgenFK Install Debug Log ===');
        debugLog('argv:', process.argv.join(' '));
        debugLog('cwd:', process.cwd());
        debugLog('rootDir:', rootDir);
        debugLog('platform:', os.platform(), '| arch:', os.arch(), '| node:', process.version);
        debugLog('WSL_DISTRO_NAME:', process.env.WSL_DISTRO_NAME || '(not set)');
        debugLog('WSL_INTEROP:', process.env.WSL_INTEROP || '(not set)');
        debugLog('AGENFK_DB_PATH env:', process.env.AGENFK_DB_PATH || '(not set)');
        debugLog('onlyPlatform:', onlyPlatform || '(none)');
        const agenfkConfigPath_ = path.join(agenfkHome, 'config.json');
        debugLog('~/.agenfk/config.json path:', agenfkConfigPath_);
        if (existsSync(agenfkConfigPath_)) {
            try {
                const cfg = readFileSync(agenfkConfigPath_, 'utf8');
                debugLog('~/.agenfk/config.json contents:', cfg.trim());
            } catch (e) {
                debugLog('~/.agenfk/config.json read error:', e.message);
            }
        } else {
            debugLog('~/.agenfk/config.json: NOT FOUND');
        }
        // Check if an agenfk server is already reachable on the persisted (or default) port
        let serverPort = process.env.AGENFK_PORT || '3000';
        try {
            const persistedPort = fs.readFileSync(path.join(os.homedir(), '.agenfk', 'server-port'), 'utf8').trim();
            if (persistedPort) serverPort = persistedPort;
        } catch { /* ignore */ }
        const serverCheck = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', `http://localhost:${serverPort}/`], { encoding: 'utf8' });
        const serverReachable = serverCheck.status === 0 && serverCheck.stdout.trim() !== '000';
        debugLog(`server on localhost:${serverPort}:`, serverReachable ? `REACHABLE (HTTP ${serverCheck.stdout.trim()})` : 'NOT REACHABLE');
        wasReachableBeforeInstall = serverReachable;
        preInstallServerPort = serverPort;
    }

    // BUG 174270e6: even when --debuglog is OFF we still need to know if a
    // server was running, so do an unconditional reachability probe here too.
    // Cheap (one localhost curl with 1s timeout). The debug branch above will
    // overwrite this with the same value if --debuglog is on; idempotent.
    if (!wasReachableBeforeInstall) {
        let probePort = process.env.AGENFK_PORT || '3000';
        try {
            const persistedPort = readFileSync(path.join(os.homedir(), '.agenfk', 'server-port'), 'utf8').trim();
            if (persistedPort) probePort = persistedPort;
        } catch { /* ignore */ }
        const probe = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', `http://localhost:${probePort}/`], { encoding: 'utf8' });
        if (probe.status === 0 && probe.stdout.trim() !== '000') {
            wasReachableBeforeInstall = true;
            preInstallServerPort = probePort;
        }
    }

    // BUG 2f491181: the reachability probe above is NOT sufficient on its own.
    // An upgrade must restart the running server in EVERY scenario, so we union
    // four independent signals — if any says a server was running, we restart:
    //
    //   1. The reachability probe above (cheap, but a 1s localhost curl can
    //      false-negative under install load).
    //   2. A direct process-liveness scan of the process table for the server
    //      bin. Timing-robust where the probe is flaky, and the decisive signal
    //      for direct / `npx` installs that never run `down`, so the server is
    //      still alive when install.mjs runs.
    //   3. AGENFK_SERVER_WAS_RUNNING — set by the `agenfk upgrade` CLI from the
    //      pre-`down` `servicesRunning` capture. Covers the manual path, where
    //      `down` has already killed the server before install.mjs runs (so 1+2
    //      both read false).
    //   4. An in-flight hub upgrade marker: `upgrade-state.json` with
    //      outcome === 'started', which the hub reconciler writes before it
    //      spawns the CLI. Self-heals the hub-driven path on the very upgrade
    //      that ships this code, since install.mjs is the only part of the
    //      upgrade that runs as the NEW (just-extracted) version.
    let upgradeInFlight = false;
    {
        const truthy = (v) => !!v && v !== '0' && v.toLowerCase() !== 'false';
        if (truthy(process.env.AGENFK_SERVER_WAS_RUNNING || '')) {
            wasReachableBeforeInstall = true;
        }
        // Signal 2: is an agenfk server process actually alive right now?
        // Cross-platform, mirrors the CLI's killPattern detection. This does
        // not depend on HTTP timing or hub connectivity — if the process is
        // there, we restart it onto the new code.
        const SERVER_PATTERN = 'packages/server/dist/server.js';
        // Only count a line as the live server if it is an actual node/bun
        // invocation of the server bin — not just any process whose argv happens
        // to embed the path (an editor with the file open, a `grep`/`tail`, this
        // install's own tooling). Mirrors killPattern's grep/ps exclusion but
        // tighter: it must look like `… node|bun … packages/server/dist/server.js`.
        const looksLikeServerCmd = (line) =>
            line.includes(SERVER_PATTERN) && /(^|[\/\\\s])(node|node\.exe|bun)([\s.]|$)/i.test(line);
        function serverProcessAlive() {
            try {
                if (process.platform === 'win32' && !(process.env.MSYSTEM || process.env.WSL_DISTRO_NAME)) {
                    const pat = SERVER_PATTERN.replace(/\//g, '\\\\');
                    const out = spawnSync('wmic', ['process', 'where', `commandline like '%${pat}%'`, 'get', 'commandline'], { encoding: 'utf8' });
                    return (out.stdout || '').split('\n').some(looksLikeServerCmd);
                }
                const out = spawnSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' });
                if (out.status === 0 && typeof out.stdout === 'string') {
                    return out.stdout.split('\n').some(looksLikeServerCmd);
                }
                // Fallback: pgrep against a node-anchored regex if ps is unavailable.
                // Escape every regex metacharacter, not just the dot — a partial escape is
                // the kind that quietly stops matching when the pattern changes.
                const pgPattern = SERVER_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pg = spawnSync('pgrep', ['-f', `(node|bun).*${pgPattern}`], { encoding: 'utf8' });
                return pg.status === 0 && (pg.stdout || '').trim().length > 0;
            } catch {
                return false;
            }
        }
        if (!wasReachableBeforeInstall && serverProcessAlive()) {
            wasReachableBeforeInstall = true;
        }
        // Resolve the .agenfk dir the server uses, mirroring the server's own
        // dbPath resolution (server.ts / start-services.mjs): AGENFK_DB_PATH,
        // then ~/.agenfk/config.json's dbPath, then <rootDir>/.agenfk.
        let dbDir = path.join(rootDir, '.agenfk');
        if (process.env.AGENFK_DB_PATH) {
            dbDir = path.dirname(process.env.AGENFK_DB_PATH);
        } else {
            try {
                const cfg = JSON.parse(readFileSync(path.join(agenfkHome, 'config.json'), 'utf8'));
                if (cfg && typeof cfg.dbPath === 'string' && cfg.dbPath) dbDir = path.dirname(cfg.dbPath);
            } catch { /* no/invalid config → keep default */ }
        }
        const upgradeStatePath = path.join(dbDir, 'upgrade-state.json');
        try {
            if (existsSync(upgradeStatePath)) {
                const st = JSON.parse(readFileSync(upgradeStatePath, 'utf8'));
                // Only treat the marker as "a server is mid-upgrade right now"
                // when it is genuinely fresh. An interrupted upgrade (install
                // threw, machine rebooted, Ctrl-C) leaves a 'started' marker
                // that is only cleared on the next server boot's replay; without
                // this age guard a later unrelated install would read that stale
                // landmine and spuriously start a server the user never ran.
                // BUG 2f491181. Markers from older servers have no startedAt —
                // those are only ever written moments before install.mjs runs,
                // so treat a missing timestamp as fresh for back-compat.
                const STALE_MS = 10 * 60 * 1000;
                let fresh = true;
                if (st && typeof st.startedAt === 'string') {
                    const age = Date.now() - Date.parse(st.startedAt);
                    fresh = Number.isFinite(age) && age >= 0 && age < STALE_MS;
                }
                if (st && st.outcome === 'started' && fresh) {
                    upgradeInFlight = true;
                    wasReachableBeforeInstall = true;
                }
            }
        } catch { /* unreadable/malformed marker → ignore */ }
    }

    function shouldRun(platform) {
        if (onlyPlatform) return onlyPlatform.toLowerCase() === platform.toLowerCase();
        if (skipPlatform) return skipPlatform.toLowerCase() !== platform.toLowerCase();
        return true;
    }

    // 1. Verify pre-built dist bundles
    const requiredDists = [
        'packages/core/dist',
        'packages/storage-sqlite/dist',
        'packages/telemetry/dist',
        'packages/cli/dist',
        'packages/server/dist',
    ];

    // Remove stale TypeScript source directories from installed packages.
    // The distributable tarball only ships pre-built dist/ — any src/ present is from
    // a previous source-based install and must be removed to prevent a future upgrade
    // from accidentally rebuilding from old source instead of using the pre-built dist.
    const staleSrcDirs = [
        'packages/core/src',
        'packages/storage-sqlite/src',
        'packages/telemetry/src',
        'packages/cli/src',
        'packages/server/src',
        'packages/ui/src',
        'packages/create/src',
    ];
    function cleanStaleSrc() {
        // Safety guard: NEVER delete source directories when running from a dev
        // checkout. A distributed tarball never contains a `.git` directory, so
        // its presence means this is a working tree whose `src/` is the
        // authoritative source, not a stale leftover from a source-based install.
        // Without this guard, running install.mjs from a clone wipes
        // packages/*/src (the cleanup assumes a dist-only tarball layout).
        if (existsSync(path.join(rootDir, '.git'))) {
            console.log('  Skipping stale-source cleanup (dev checkout detected: .git present).');
            return;
        }
        let cleaned = 0;
        for (const d of staleSrcDirs) {
            const fullPath = path.join(rootDir, d);
            if (existsSync(fullPath)) {
                rmSync(fullPath, { recursive: true, force: true });
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`  Removed ${cleaned} stale source director${cleaned === 1 ? 'y' : 'ies'} (pre-built mode).`);
    }

    // If dists are missing, attempt to re-download the release tarball for this version.
    async function autoHealRedownload() {
        let pkgVersion = '0.0.0';
        try {
            const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
            pkgVersion = pkg.version || pkgVersion;
        } catch { /* ignore */ }

        const REPO = 'cglab-public/agenfk';
        const tag = `v${pkgVersion}`;
        const url = `https://github.com/${REPO}/releases/download/${tag}/agenfk-dist.tar.gz`;
        const tmpFile = path.join(os.tmpdir(), `agenfk-heal-${Date.now()}.tar.gz`);

        console.log(`${YELLOW}[1/14] Pre-built artifacts missing — auto-heal re-download for ${tag}...${NC}`);
        try {
            // Try curl first
            const curlResult = spawnSync('curl', ['-fsSL', '-o', tmpFile, url], { stdio: 'pipe' });
            if (curlResult.status !== 0) {
                // gh CLI fallback
                const tmpDir = path.dirname(tmpFile);
                const ghResult = spawnSync('gh', ['release', 'download', tag, '--repo', REPO,
                    '--pattern', 'agenfk-dist.tar.gz', '-D', tmpDir, '--clobber'], { stdio: 'pipe' });
                if (ghResult.status !== 0) return false;
                const ghFile = path.join(tmpDir, 'agenfk-dist.tar.gz');
                if (existsSync(ghFile)) renameSync(ghFile, tmpFile);
                else return false;
            }
            // On Windows, BSD tar treats "C:" as a remote hostname — --force-local disables that.
            // On MinGW (Git for Windows) we also convert paths to POSIX form (/c/Users/...)
            // so MSYS2 tar never sees a bare "C:" regardless of --force-local support.
            const tarArgs = os.platform() === 'win32'
                ? ['--force-local', '-xzf', toPosixPath(tmpFile), '-C', toPosixPath(rootDir)]
                : ['-xzf', tmpFile, '-C', rootDir];
            const tarResult = spawnSync('tar', tarArgs, { stdio: 'inherit' });
            if (tarResult.status !== 0) return false;
            console.log(`${GREEN}  Re-download complete.${NC}`);
            return true;
        } catch { return false; } finally {
            if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
        }
    }

    if (!onlyPlatform) {
        let missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));

        if (debuglog) {
            debugLog('--- Dist check ---');
            for (const d of requiredDists) {
                const full = path.join(rootDir, d);
                debugLog(`  dist ${d}: ${existsSync(full) ? 'PRESENT' : 'MISSING'}`);
            }
            debugLog('missingDists count:', missingDists.length);
            if (missingDists.length > 0) debugLog('missing:', missingDists.join(', '));
            const presentStaleSrc = staleSrcDirs.filter(d => existsSync(path.join(rootDir, d)));
            debugLog('staleSrcDirs present:', presentStaleSrc.length > 0 ? presentStaleSrc.join(', ') : '(none)');
        }

        if (missingDists.length > 0) {
            debugLog('trigger: missing dists → attempting auto-heal re-download');
            const healed = await autoHealRedownload();
            debugLog('auto-heal result:', healed ? 'SUCCESS' : 'FAILED');
            if (healed) missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));
            debugLog('missingDists after heal:', missingDists.length);
        }

        if (missingDists.length > 0) {
            console.error(`${YELLOW}Installation failed: pre-built dist bundles are missing and could not be downloaded.`);
            console.error(`  Missing: ${missingDists.join(', ')}`);
            console.error(`  Download the latest release manually from https://github.com/cglab-public/agenfk/releases${NC}`);
            process.exit(1);
        }

        debugLog('decision: all pre-built dists present');
        console.log(`${GREEN}[1/14] Pre-built dist bundles verified.${NC}`);
        cleanStaleSrc();
    } else {
        const missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));
        if (missingDists.length > 0) {
            debugLog('trigger (onlyPlatform mode): missing dists → attempting re-download');
            const healed = await autoHealRedownload();
            if (!healed || requiredDists.some(d => !existsSync(path.join(rootDir, d)))) {
                console.error(`${YELLOW}Integration install failed: pre-built dist bundles are missing.`);
                console.error(`  Download the latest release from https://github.com/cglab-public/agenfk/releases${NC}`);
                process.exit(1);
            }
        }
    }

    // 1b. Install production dependencies (node_modules not shipped in tarball)
    if (!onlyPlatform) {
        const nodeModulesPath = path.join(rootDir, 'node_modules');
        const npmCiCmd = (os.platform() === 'win32' && !isMinGW) ? 'npm.cmd' : 'npm';
        if (!existsSync(nodeModulesPath)) {
            console.log(`${GREEN}[1b/14] Installing production dependencies (npm ci --omit=dev)...${NC}`);
        } else {
            console.log(`${GREEN}[1b/14] Production dependencies already present, skipping npm ci.${NC}`);
        }
        const npmCiResult = spawnSync(npmCiCmd, ['ci', '--omit=dev', '--ignore-scripts'], {
            cwd: rootDir,
            stdio: 'inherit',
            shell: os.platform() === 'win32', // .cmd scripts need shell on Windows (MinGW + native)
        });
        if (npmCiResult.status !== 0) {
            console.log(`${YELLOW}  Warning: npm ci failed (exit ${npmCiResult.status}). Run 'npm ci --omit=dev' manually in ${rootDir} if agenfk commands fail to resolve modules.${NC}`);
        }
    }

    // 2. Generate install-time secret verify token
    if (!onlyPlatform) {
        console.log(`${GREEN}[2/14] Generating secret verify token...${NC}`);
        if (!existsSync(agenfkHome)) {
            await fs.mkdir(agenfkHome, { recursive: true });
        }
        const tokenPath = path.join(agenfkHome, 'verify-token');
        if (!existsSync(tokenPath)) {
            const token = crypto.randomBytes(32).toString('hex');
            await fs.writeFile(tokenPath, token, 'utf8');
            chmodSync(tokenPath, 0o600);
            console.log(`  Generated: ${tokenPath}`);
        } else {
            console.log(`  Token already exists: ${tokenPath}`);
        }
    }

    // 3. Database and rules scope configuration
    const agenfkConfigPath = path.join(agenfkHome, 'config.json');
    let dbPath = '';
    let existingConfig = {};

    if (existsSync(agenfkConfigPath)) {
        try {
            existingConfig = JSON.parse(readFileSync(agenfkConfigPath, 'utf8'));
            if (existingConfig.dbPath) {
                dbPath = existingConfig.dbPath;
                if (!onlyPlatform) console.log(`  Using existing database configuration: ${dbPath}`);
            }
        } catch (e) {}
    }

    // Resolve the effective MCP preference (CLI-only is the default):
    //   --no-mcp           → false (and persisted)
    //   --with-mcp         → true  (and persisted)
    //   AGENFK_WITH_MCP=1  → true
    //   config.withMcp     → prior opt-in
    //   otherwise          → false (CLI-only)
    const withMcp = noMcpArg
        ? false
        : (withMcpArg || process.env.AGENFK_WITH_MCP === '1' || existingConfig.withMcp === true);
    if (!onlyPlatform) {
        console.log(withMcp
            ? `  MCP: enabled (registering agenfk MCP server with detected clients)`
            : `  MCP: disabled — CLI-only mode (pass --with-mcp to register the MCP server)`);
    }

    // Codex is the exception: MCP is on by default (its sandbox blocks the CLI's
    // localhost calls). Resolve it separately so a prior --no-mcp opt-out is sticky
    // across flag-less upgrades instead of silently re-registering.
    const codexMcp = shouldRegisterCodexMcp({ noMcp: noMcpArg, withMcp, persistedCodexMcp: existingConfig.codexMcp });
    if (!onlyPlatform || onlyPlatform === 'codex') {
        console.log(`  MCP (Codex): ${codexMcp ? 'enabled by default' : 'disabled (--no-mcp)'}`);
    }

    // Resolve rulesScope: CLI flag → AGENFK_RULES_SCOPE env → config → prompt (TTY only).
    // Under npx / piped stdin there is no TTY: prompting there used to leave the readline
    // promise unresolved, so Node exited 0 and the rest of the install (incl. the CLI
    // symlink) was silently skipped (issue #86). resolveRulesScope guarantees a decision
    // without blocking when stdin is non-interactive.
    let { scope: rulesScope, shouldPrompt } = resolveRulesScope({
        rulesScopeArg,
        envScope: process.env.AGENFK_RULES_SCOPE,
        existingScope: existingConfig.rulesScope,
        isTTY: process.stdin.isTTY,
    });
    if (shouldPrompt && !onlyPlatform) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await ask(rl, `\n${BLUE}Where should AgEnFK workflow rules be installed?${NC}\n  1) global  — ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, etc.\n  2) project — .claude/CLAUDE.md, AGENTS.md in project root, etc.\n\nChoose [global/project] (default: global): `);
        rl.close();
        rulesScope = answer.trim().toLowerCase() === 'project' ? 'project' : 'global';
    }
    if (!onlyPlatform) console.log(`  Rules scope: ${rulesScope}`);

    let configDirty = false;

    if (!dbPath || dbPath.endsWith('.json')) {
        // Always use SQLite. If a legacy .json path was configured, remap it.
        if (dbPath && dbPath.endsWith('.json')) {
            console.log(`  Remapping legacy JSON database path to SQLite...`);
        } else if (!onlyPlatform) {
            console.log(`${GREEN}[3/14] Configuring database engine (SQLite)...${NC}`);
        }
        dbPath = path.join(rootDir, '.agenfk', 'db.sqlite');
        console.log(`  Using: SQLITE (${dbPath})`);
        configDirty = true;
    }

    if (existingConfig.rulesScope !== rulesScope) {
        configDirty = true;
    }

    if (existingConfig.withMcp !== withMcp) {
        configDirty = true;
    }

    if (existingConfig.codexMcp !== codexMcp) {
        configDirty = true;
    }

    if (configDirty) {
        // 3a. Write ~/.agenfk/config.json
        const configData = { ...existingConfig, dbPath, rulesScope, withMcp, codexMcp, telemetry: existingConfig.telemetry ?? true };
        await fs.writeFile(agenfkConfigPath, JSON.stringify(configData, null, 2), 'utf8');
        console.log(`  Config written: ${agenfkConfigPath}`);
    }

    debugLog('dbPath resolved:', dbPath || '(empty — not yet set)');
    debugLog('dbPath file exists:', dbPath ? existsSync(dbPath) : false);

    // Hoist path constants needed both inside and outside the rulesOnly block
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    const gatekeeperDestBase = path.join(localBinDir, 'agenfk-gatekeeper');
    const gatekeeperDest = os.platform() === 'win32' ? `${gatekeeperDestBase}.cmd` : gatekeeperDestBase;
    const enforcerDestBase = path.join(localBinDir, 'agenfk-mcp-enforcer');
    const enforcerDest = os.platform() === 'win32' ? `${enforcerDestBase}.cmd` : enforcerDestBase;
    const prHookDestBase = path.join(localBinDir, 'agenfk-pr-hook');
    const prHookDest = os.platform() === 'win32' ? `${prHookDestBase}.cmd` : prHookDestBase;
    const testGuardDestBase = path.join(localBinDir, 'agenfk-test-guard');
    const testGuardDest = os.platform() === 'win32' ? `${testGuardDestBase}.cmd` : testGuardDestBase;

    // --rules-only: skip steps 3b–12, jump straight to rules installation (step 13)
    if (rulesOnly) {
        console.log(`${BLUE}  --rules-only: skipping non-rules steps, jumping to rules installation...${NC}`);
    }

    if (!rulesOnly) {
    // 3b. Auto-migrate legacy db.json → SQLite migration.json
    if (!onlyPlatform) {
        const localAgenfkDir = path.join(rootDir, '.agenfk');
        const dbJsonPath = path.join(localAgenfkDir, 'db.json');
        const migrationPath = path.join(agenfkHome, 'migration.json');
        if (existsSync(dbJsonPath) && !existsSync(migrationPath)) {
            try {
                const raw = readFileSync(dbJsonPath, 'utf8');
                const data = JSON.parse(raw);
                writeFileSync(migrationPath, JSON.stringify({
                    version: data.version || '1',
                    backupDate: new Date().toISOString(),
                    dbType: 'json',
                    projects: data.projects || [],
                    items: data.items || [],
                }, null, 2));
                console.log(`  ${GREEN}Legacy db.json detected — data staged for migration to SQLite on first server start.${NC}`);
            } catch (e) {
                console.log(`  ${YELLOW}Warning: Could not read db.json for migration: ${e.message}${NC}`);
            }
        }
    }

    // 3c. Restore from backup (new install only)
    if (!onlyPlatform) {
        const backupDir = path.join(agenfkHome, 'backup');
        const isNewInstall = !existsSync(dbPath);
        if (isNewInstall && existsSync(backupDir)) {
            const backups = readdirSync(backupDir)
                .filter(f => f.startsWith('agenfk-backup-') && f.endsWith('.json'))
                .sort()
                .reverse();
            if (backups.length > 0) {
                console.log(`\n${YELLOW}  Found ${backups.length} backup(s) in ${backupDir}.${NC}`);
                backups.slice(0, 5).forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
                const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
                try {
                    const ans = await ask(rl2, `  Restore latest backup? [y/N]: `);
                    if (ans.trim().toLowerCase() === 'y') {
                        const migrationPath = path.join(agenfkHome, 'migration.json');
                        copyFileSync(path.join(backupDir, backups[0]), migrationPath);
                        console.log(`  ${GREEN}Backup staged for restore — will be imported on first server start.${NC}`);
                    }
                } finally {
                    rl2.close();
                }
            }
        }
    }

    // 4. Ensure configuration exists
    if (!onlyPlatform) {
        console.log(`${GREEN}[4/14] Initializing configuration...${NC}`);
        const localConfigDir = path.join(rootDir, '.agenfk');
        if (!existsSync(localConfigDir)) {
            spawnSync(process.execPath, [path.join(rootDir, 'packages/cli/bin/agenfk.js'), 'init'], { stdio: 'inherit' });
        }
    }

    // 5. Create start script for UI/API
    if (!onlyPlatform) {
        console.log(`${GREEN}[5/14] Creating background service script (start-services.mjs)...${NC}`);
        const startScriptPath = path.join(rootDir, 'scripts', 'start-services.mjs');
        const serverPath = path.join(rootDir, 'packages', 'server', 'dist', 'index.js');
        const uiDir = path.join(rootDir, 'packages', 'ui');
        
        const startScriptContent = `
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const agenfkDir = path.join(rootDir, '.agenfk');

// Resolve dbPath: env var → ~/.agenfk/config.json → default
function resolveDbPath() {
    if (process.env.AGENFK_DB_PATH) return process.env.AGENFK_DB_PATH;
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (cfg.dbPath) return cfg.dbPath;
        } catch (e) {}
    }
    return path.join(agenfkDir, 'db.sqlite');
}
const dbPath = resolveDbPath();

const REQUESTED_API_PORT = process.env.AGENFK_PORT || '3000';
const UI_PORT = process.env.VITE_PORT || '5173';
const SERVER_PORT_FILE = path.join(os.homedir(), '.agenfk', 'server-port');

if (!fs.existsSync(agenfkDir)) {
    fs.mkdirSync(agenfkDir, { recursive: true });
}

try { fs.unlinkSync(SERVER_PORT_FILE); } catch { /* ignore */ }

console.log(\`Starting API Server (requested port \${REQUESTED_API_PORT})...\`);
const apiLogPath = path.join(agenfkDir, 'api.log');
const apiLog = fs.openSync(apiLogPath, 'w');
const apiProcess = spawn('node', [path.join(rootDir, 'packages/server/dist/server.js')], {
    env: { ...process.env, AGENFK_DB_PATH: dbPath, AGENFK_PORT: REQUESTED_API_PORT, VITE_PORT: UI_PORT },
    detached: true,
    stdio: ['ignore', apiLog, apiLog]
});
apiProcess.unref();

let API_PORT = REQUESTED_API_PORT;
for (let i = 0; i < 30; i++) {
    if (fs.existsSync(SERVER_PORT_FILE)) {
        try {
            const persisted = fs.readFileSync(SERVER_PORT_FILE, 'utf8').trim();
            if (persisted) { API_PORT = persisted; break; }
        } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 500));
}
if (API_PORT !== REQUESTED_API_PORT) {
    console.log(\`API Server bound to port \${API_PORT} (requested \${REQUESTED_API_PORT} was unavailable).\`);
}

console.log(\`Starting UI on port \${UI_PORT}...\`);
const uiLogPath = path.join(agenfkDir, 'ui.log');
const uiLog = fs.openSync(uiLogPath, 'w');
const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
const npmCmd = (os.platform() === 'win32' && !isMinGW) ? 'npm.cmd' : 'npm';
const uiProcess = spawn(npmCmd, ['run', 'preview'], {
    cwd: path.join(rootDir, 'packages/ui'),
    env: { ...process.env, VITE_PORT: UI_PORT, VITE_API_URL: \`http://localhost:\${API_PORT}\` },
    detached: true,
    stdio: ['ignore', uiLog, uiLog],
    shell: os.platform() === 'win32', // .cmd scripts need shell on Windows (MinGW + native)
});
uiProcess.unref();

console.log("Services started in background.");
console.log(\`API: http://localhost:\${API_PORT}\`);
console.log("Database: " + dbPath);
console.log("Logs: " + path.join(agenfkDir, '*.log'));

// Simple wait for UI
console.log("Waiting for UI to be ready...");
let uiUrl = \`http://localhost:\${UI_PORT}\`;
for (let i = 0; i < 15; i++) {
    if (fs.existsSync(uiLogPath)) {
        const content = fs.readFileSync(uiLogPath, 'utf8');
        const matches = content.match(/http:\\/\\/localhost:[0-9]+/g);
        if (matches) {
            uiUrl = matches[matches.length - 1];
            break;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log("UI available at: " + uiUrl);

// AGENFK_NO_OPEN_BROWSER gates the auto-open so fleet-driven restarts
// (agenfk restart --quiet) don't surface a new browser tab.
if (process.env.AGENFK_NO_OPEN_BROWSER) {
    process.exit(0);
}

if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', uiUrl], { detached: true, stdio: 'ignore' }).unref();
} else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore' }).unref();
}

process.exit(0);
`;
        await fs.writeFile(startScriptPath, startScriptContent.trim() + '\n', 'utf8');
        console.log(`  Created: ${startScriptPath}`);
    }

    const serverPath = path.join(rootDir, 'packages', 'server', 'dist', 'index.js');

    // 6. Configure Opencode MCP
    if (withMcp && shouldRun('opencode')) {
        console.log(`${GREEN}[6/14] Configuring Opencode MCP...${NC}`);
        const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
        const opencodeInstalled = spawnSync(getCliCommand('opencode'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (existsSync(opencodeConfigPath) || opencodeInstalled) {
            try {
                let config = {};
                if (existsSync(opencodeConfigPath)) {
                    const rawContent = (await fs.readFile(opencodeConfigPath, 'utf8')).trim();
                    if (rawContent) {
                        config = JSON.parse(rawContent);
                    }
                } else {
                    await fs.mkdir(path.dirname(opencodeConfigPath), { recursive: true });
                    console.log(`  Opencode detected but opencode.json missing — creating it.`);
                }
                if (!config.mcp) config.mcp = {};

                config.mcp.agenfk = {
                    type: 'local',
                    enabled: true,
                    command: ['node', serverPath],
                    environment: {
                        NODE_ENV: 'production',
                        AGENFK_DB_PATH: dbPath
                    }
                };

                await fs.writeFile(opencodeConfigPath, JSON.stringify(config, null, 2));
                console.log(`  Written: ${opencodeConfigPath}`);
            } catch (e) {
                console.error('Error updating opencode.json:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`Opencode not found. Skipping opencode.json configuration.`);
        }
    }

    // 6b. Configure Cursor MCP
    if (withMcp && shouldRun('cursor')) {
        console.log(`${GREEN}[6b/14] Configuring Cursor MCP...${NC}`);
        const cursorMcpPath = getCursorMcpPath();
        const cursorConfigDir = path.dirname(cursorMcpPath);
        const cursorCmd = getCliCommand('cursor');
        const cursorInstalled = existsSync(cursorConfigDir) ||
            spawnSync(cursorCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (cursorInstalled) {
            try {
                let cursorMcp = {};
                if (existsSync(cursorMcpPath)) {
                    const rawContent = (await fs.readFile(cursorMcpPath, 'utf8')).trim();
                    if (rawContent) {
                        cursorMcp = JSON.parse(rawContent);
                    }
                } else {
                    await fs.mkdir(cursorConfigDir, { recursive: true });
                    console.log(`  Cursor config dir not found — creating it.`);
                }
                if (!cursorMcp.mcpServers) cursorMcp.mcpServers = {};

                // Normalize paths written into the config file: Cursor is a native Windows
                // Electron app and cannot resolve MinGW POSIX paths (/c/Users/...).
                const cursorServerPath = isMinGW ? toWindowsPath(serverPath) : serverPath;
                const cursorDbPath = isMinGW ? toWindowsPath(dbPath) : dbPath;

                cursorMcp.mcpServers.agenfk = {
                    command: 'node',
                    args: [cursorServerPath],
                    env: {
                        NODE_ENV: 'production',
                        AGENFK_DB_PATH: cursorDbPath
                    }
                };

                await fs.writeFile(cursorMcpPath, JSON.stringify(cursorMcp, null, 2));
                console.log(`  Written: ${cursorMcpPath}`);
            } catch (e) {
                console.error('Error updating Cursor mcp.json:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Cursor not found. Skipping Cursor MCP configuration.`);
        }
    }

    // 6c. Configure Codex MCP — on by DEFAULT (unless --no-mcp), unlike other
    // clients. Codex's sandbox often blocks outbound localhost, so the CLI can't
    // reach the local API server; the MCP stdio server is not sandbox-restricted.
    if (codexMcp && shouldRun('codex')) {
        console.log(`${GREEN}[6c/14] Configuring Codex MCP (default for Codex)...${NC}`);
        const codexCmd = getCliCommand('codex');
        const codexInstalled = spawnSync(codexCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (codexInstalled) {
            try {
                console.log("  Registering AgenFK MCP server with Codex...");
                // Remove any existing registration first (ignore errors if not registered)
                spawnSync(codexCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'ignore' });
                const result = spawnSync(codexCmd, [
                    'mcp', 'add',
                    '--env', `AGENFK_DB_PATH=${dbPath}`,
                    '--',
                    'agenfk',
                    'node', serverPath
                ], { stdio: 'inherit' });
                if (result.status === 0) {
                    console.log(`  ${GREEN}Registered agenfk MCP server with Codex.${NC}`);
                } else {
                    console.log(`  ${YELLOW}Warning: codex mcp add returned non-zero. Verify manually.${NC}`);
                }
            } catch (e) {
                console.error('  Error configuring Codex MCP:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Codex not found. Skipping Codex MCP configuration.`);
        }
    }

    // 6d. Configure Gemini CLI MCP
    if (withMcp && shouldRun('gemini')) {
        console.log(`${GREEN}[6d/14] Configuring Gemini CLI MCP...${NC}`);
        const geminiCmd = getCliCommand('gemini');
        const geminiInstalled = spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (geminiInstalled) {
            try {
                console.log("  Registering AgenFK MCP server with Gemini CLI...");
                // Remove any existing registration first (ignore errors if not registered)
                spawnSync(geminiCmd, ['mcp', 'remove', '-s', 'user', 'agenfk'], { stdio: 'ignore' });
                const result = spawnSync(geminiCmd, [
                    'mcp', 'add',
                    '-s', 'user',
                    '-e', `AGENFK_DB_PATH=${dbPath}`,
                    'agenfk',
                    'node', serverPath
                ], { stdio: 'inherit' });
                if (result.status === 0) {
                    console.log(`  ${GREEN}Registered agenfk MCP server with Gemini CLI.${NC}`);
                } else {
                    console.log(`  ${YELLOW}Warning: gemini mcp add returned non-zero. Verify manually.${NC}`);
                }
            } catch (e) {
                console.error('  Error configuring Gemini CLI MCP:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Gemini CLI not found. Skipping Gemini CLI MCP configuration.`);
        }
    }

    // 6e. CLI-only cleanup: when MCP is NOT opted into, ensure no stale agenfk MCP
    // server remains registered with any client. This makes upgrades flip cleanly
    // to CLI-only instead of leaving a half-state where old registrations linger.
    // Idempotent: removing an unregistered server is a no-op.
    if (!withMcp) {
        console.log(`${GREEN}[6e/14] Ensuring CLI-only mode (unregistering any existing agenfk MCP server)...${NC}`);

        if (shouldRun('claude')) {
            const claudeCmd = getCliCommand('claude');
            if (spawnSync(claudeCmd, ['--version'], { stdio: 'ignore' }).status === 0) {
                spawnSync(claudeCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'ignore' });
            }
        }
        // Codex is the exception: MCP is on by default there (§6c registered it),
        // so only unregister it when Codex MCP is actually disabled (--no-mcp, or a
        // persisted opt-out).
        if (!codexMcp && shouldRun('codex')) {
            const codexCmd = getCliCommand('codex');
            if (spawnSync(codexCmd, ['--version'], { stdio: 'ignore' }).status === 0) {
                spawnSync(codexCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'ignore' });
            }
        }
        if (shouldRun('gemini')) {
            const geminiCmd = getCliCommand('gemini');
            if (spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' }).status === 0) {
                spawnSync(geminiCmd, ['mcp', 'remove', '-s', 'user', 'agenfk'], { stdio: 'ignore' });
            }
        }
        if (shouldRun('opencode')) {
            const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
            if (existsSync(opencodeConfigPath)) {
                try {
                    const cfg = JSON.parse((await fs.readFile(opencodeConfigPath, 'utf8')).trim() || '{}');
                    if (cfg.mcp && cfg.mcp.agenfk) {
                        delete cfg.mcp.agenfk;
                        await fs.writeFile(opencodeConfigPath, JSON.stringify(cfg, null, 2));
                        console.log(`  Removed agenfk MCP from ${opencodeConfigPath}`);
                    }
                } catch (e) {
                    console.error('  Error cleaning opencode.json:', e.message);
                }
            }
        }
        if (shouldRun('cursor')) {
            const cursorMcpPath = getCursorMcpPath();
            if (existsSync(cursorMcpPath)) {
                try {
                    const cursorMcp = JSON.parse((await fs.readFile(cursorMcpPath, 'utf8')).trim() || '{}');
                    if (cursorMcp.mcpServers && cursorMcp.mcpServers.agenfk) {
                        delete cursorMcp.mcpServers.agenfk;
                        await fs.writeFile(cursorMcpPath, JSON.stringify(cursorMcp, null, 2));
                        console.log(`  Removed agenfk MCP from ${cursorMcpPath}`);
                    }
                } catch (e) {
                    console.error('  Error cleaning Cursor mcp.json:', e.message);
                }
            }
        }
    }

    // 7. Configure Claude Code MCP (deferred — runs after step 9 once cliDest is known)

    // 8. Install AgenFK Skills
    if (shouldRun('opencode')) {
        console.log(`${GREEN}[8/14] Installing agenfk skills (Opencode)...${NC}`);
        const skillsDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk');
        await fs.mkdir(skillsDir, { recursive: true });
        const skillSource = path.join(rootDir, 'SKILL.md');
        if (existsSync(skillSource)) {
            await fs.copyFile(skillSource, path.join(skillsDir, 'SKILL.md'));
            console.log(`Successfully installed agenfk skills to ${skillsDir}`);
        } else if (!onlyPlatform) {
            console.log(`SKILL.md not found in ${rootDir}. Skipping skills installation.`);
        }
    }

    // 8b. Install agenfk-flow skill for all platforms
    console.log(`${GREEN}[8b/14] Installing agenfk-flow skill...${NC}`);

    // Claude Code: ~/.claude/skills/<name>/SKILL.md (all 16 skills)
    if (shouldRun('claude')) {
        const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
        const commandsDir = path.join(rootDir, 'commands');
        if (existsSync(commandsDir)) {
            const files = await fs.readdir(commandsDir);
            for (const file of files) {
                if (!isInstallableMarkdown(file)) continue;
                const skillName = file.replace(/\.md$/, '');
                const skillDir = path.join(claudeSkillsDir, skillName);
                await fs.mkdir(skillDir, { recursive: true });
                
                let content;
                if (skillName === 'agenfk-flow') {
                    const claudeFlowSkillSource = path.join(rootDir, 'skills', 'claude-code', 'agenfk-flow', 'SKILL.md');
                    if (existsSync(claudeFlowSkillSource)) {
                        content = await fs.readFile(claudeFlowSkillSource, 'utf8');
                    } else {
                        content = await fs.readFile(path.join(commandsDir, file), 'utf8');
                    }
                } else {
                    content = await fs.readFile(path.join(commandsDir, file), 'utf8');
                }

                // Inject 'name' field if missing
                if (content.startsWith('---\n') && !content.match(/^name:\s/m)) {
                    content = content.replace('---\n', `---\nname: ${skillName}\n`);
                }
                const dest = path.join(skillDir, 'SKILL.md');
                await fs.writeFile(dest, content, 'utf8');
                console.log(`  Installed Claude Skill: ${dest}`);
            }
        }
    }

    // Opencode: ~/.config/opencode/skills/agenfk-flow/SKILL.md
    if (shouldRun('opencode')) {
        const opencodeFlowSkillSource = path.join(rootDir, 'skills', 'opencode', 'agenfk-flow', 'SKILL.md');
        if (existsSync(opencodeFlowSkillSource)) {
            const opencodeFlowSkillDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk-flow');
            await fs.mkdir(opencodeFlowSkillDir, { recursive: true });
            await fs.copyFile(opencodeFlowSkillSource, path.join(opencodeFlowSkillDir, 'SKILL.md'));
            console.log(`  Installed: ${path.join(opencodeFlowSkillDir, 'SKILL.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/opencode/agenfk-flow/SKILL.md not found. Skipping.${NC}`);
        }
    }

    // Cursor: ~/.cursor/rules/agenfk-flow.mdc (or platform-appropriate path)
    if (shouldRun('cursor')) {
        const cursorFlowSkillSource = path.join(rootDir, 'skills', 'cursor', 'agenfk-flow.mdc');
        if (existsSync(cursorFlowSkillSource)) {
            const cursorRulesDir = getCursorRulesDir();
            await fs.mkdir(cursorRulesDir, { recursive: true });
            await fs.copyFile(cursorFlowSkillSource, path.join(cursorRulesDir, 'agenfk-flow.mdc'));
            console.log(`  Installed: ${path.join(cursorRulesDir, 'agenfk-flow.mdc')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/cursor/agenfk-flow.mdc not found. Skipping.${NC}`);
        }
    }

    // Codex: ~/.codex/agenfk-flow.md
    if (shouldRun('codex')) {
        const codexFlowSkillSource = path.join(rootDir, 'skills', 'codex', 'agenfk-flow.md');
        if (existsSync(codexFlowSkillSource)) {
            const codexDir = path.join(os.homedir(), '.codex');
            await fs.mkdir(codexDir, { recursive: true });
            await fs.copyFile(codexFlowSkillSource, path.join(codexDir, 'agenfk-flow.md'));
            console.log(`  Installed: ${path.join(codexDir, 'agenfk-flow.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/codex/agenfk-flow.md not found. Skipping.${NC}`);
        }
    }

    // Gemini CLI: ~/.gemini/agenfk-flow.md
    if (shouldRun('gemini')) {
        const geminiFlowSkillSource = path.join(rootDir, 'skills', 'gemini', 'agenfk-flow.md');
        if (existsSync(geminiFlowSkillSource)) {
            const geminiDir = path.join(os.homedir(), '.gemini');
            await fs.mkdir(geminiDir, { recursive: true });
            await fs.copyFile(geminiFlowSkillSource, path.join(geminiDir, 'agenfk-flow.md'));
            console.log(`  Installed: ${path.join(geminiDir, 'agenfk-flow.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/gemini/agenfk-flow.md not found. Skipping.${NC}`);
        }
    }

    // 8e. Universal skills: install all commands/*.md to ~/.agents/skills/<name>/SKILL.md
    // This path is the primary skill discovery location for Codex and is also supported
    // by OpenCode, Gemini CLI, Cursor, and other agents-compatible tools.
    console.log(`${GREEN}[8e/14] Installing universal skills (~/.agents/skills/)...${NC}`);
    {
        const agentsSkillsDir = path.join(os.homedir(), '.agents', 'skills');
        const commandsDir = path.join(rootDir, 'commands');
        if (existsSync(commandsDir)) {
            const files = await fs.readdir(commandsDir);
            for (const file of files) {
                if (!isInstallableMarkdown(file)) continue;
                const skillName = file.replace(/\.md$/, '');
                const skillDir = path.join(agentsSkillsDir, skillName);
                await fs.mkdir(skillDir, { recursive: true });
                let content = readFileSync(path.join(commandsDir, file), 'utf8');
                // Inject 'name' field if missing (required by Codex, OpenCode, Cursor, Gemini)
                if (content.startsWith('---\n') && !content.match(/^name:\s/m)) {
                    content = content.replace('---\n', `---\nname: ${skillName}\n`);
                }
                const dest = path.join(skillDir, 'SKILL.md');
                writeFileSync(dest, content, 'utf8');
                console.log(`  Installed: ${dest}`);
            }
        }
    }

    // 8f. Remove repo-private release commands stale from previous versions.
    // agenfk-release / agenfk-release-beta / agenfk-release-hub cut releases of
    // the agenfk framework itself and moved to the repo's own .claude/commands/;
    // they used to ship globally, so upgrades must delete the old copies from
    // every client target (uninstall already removes them via the agenfk* glob).
    console.log(`${GREEN}[8f/14] Removing stale repo-private release commands...${NC}`);
    {
        const stale = ['agenfk-release', 'agenfk-release-beta', 'agenfk-release-hub'];
        const targets = [];
        for (const name of stale) {
            // Gemini tomls are written prefix-stripped: agenfk-release.md → agenfk/release.toml (see step 10c).
            const geminiName = name.replace(/^agenfk-/, '');
            targets.push(
                path.join(os.homedir(), '.claude', 'commands', `${name}.md`),
                path.join(os.homedir(), '.claude', 'skills', name),
                path.join(os.homedir(), '.config', 'opencode', 'commands', `${name}.md`),
                path.join(os.homedir(), '.config', 'opencode', 'skills', name),
                path.join(os.homedir(), '.gemini', 'commands', 'agenfk', `${geminiName}.toml`),
                path.join(os.homedir(), '.agents', 'skills', name),
            );
        }
        for (const target of targets) {
            if (existsSync(target)) {
                await fs.rm(target, { recursive: true, force: true });
                console.log(`  Removed stale: ${target}`);
            }
        }
    }

    // 9. Symlink CLI to ~/.local/bin
    const cliSource = path.join(rootDir, 'packages', 'cli', 'bin', 'agenfk.js');
    const cliDestBase = path.join(localBinDir, 'agenfk');
    const cliDest = os.platform() === 'win32' ? `${cliDestBase}.cmd` : cliDestBase;

    if (!onlyPlatform) {
        console.log(`${GREEN}[9/14] Installing agenfk command to ~/.local/bin...${NC}`);
        await fs.mkdir(localBinDir, { recursive: true });
        
        if (os.platform() === 'win32') {
            // Always write .cmd on Windows
            await fs.writeFile(`${cliDestBase}.cmd`, `@echo off\nnode "${cliSource}" %*`, 'utf8');
            // If MinGW, also write extension-less version for bash
            if (isMinGW) {
                await fs.writeFile(cliDestBase, `#!/bin/sh\nnode "${cliSource}" "$@"`, 'utf8');
                chmodSync(cliDestBase, 0o755);
            }
        } else {
            try {
                if (existsSync(cliDestBase)) await fs.unlink(cliDestBase);
                await fs.symlink(cliSource, cliDestBase);
                chmodSync(cliSource, 0o755);
            } catch (e) {
                await fs.copyFile(cliSource, cliDestBase);
                chmodSync(cliDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${cliDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);

        // Ensure ~/.local/bin is on PATH in shell rc files (Linux/macOS only)
        if (os.platform() !== 'win32') {
            const pathDirs = (process.env.PATH || '').split(':');
            const alreadyOnPath = pathDirs.some(d => d === localBinDir || d === `${os.homedir()}/.local/bin`);
            let rcModified = false;
            if (!alreadyOnPath) {
                const exportLine = `\nexport PATH="$HOME/.local/bin:$PATH"`;
                const rcFiles = [
                    path.join(os.homedir(), '.zshrc'),
                    path.join(os.homedir(), '.bashrc'),
                    path.join(os.homedir(), '.profile'),
                ];
                for (const rc of rcFiles) {
                    try {
                        const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
                        if (!existing.includes('.local/bin')) {
                            await fs.appendFile(rc, exportLine, 'utf8');
                            rcModified = true;
                            console.log(`  Added ~/.local/bin to PATH in ${path.basename(rc)}`);
                        }
                    } catch { /* skip unwritable files */ }
                }
            }
            // Only suggest sourcing an rc file when we actually modified one (#86 #4).
            // If ~/.local/bin was already on PATH, sourcing rc does nothing for the
            // freshly-created symlink — point at the real fix instead.
            const shell = path.basename(process.env.SHELL || '');
            const sourceHint = shellSourceHint({ rcModified, shell });
            if (sourceHint) {
                console.log(`\n${YELLOW}  ⚠ Open a new terminal (or run: ${sourceHint}) for 'agenfk' to be available in your PATH.${NC}`);
            } else {
                console.log(`\n${YELLOW}  ⚠ '${cliDestBase}' is ready. If your shell doesn't find 'agenfk' yet, open a new terminal (or run: hash -r).${NC}`);
            }
        }
    }

    // 10 & 11. Global Slash Commands
    const integrations = [
        { name: 'Opencode', platform: 'opencode', targetBase: path.join(os.homedir(), '.config', 'opencode', 'commands') },
        { name: 'Claude Code', platform: 'claude', targetBase: path.join(os.homedir(), '.claude', 'commands') }
    ];

    for (const integration of integrations) {
        if (shouldRun(integration.platform)) {
            console.log(`${GREEN}[10-11/14] Installing global slash commands (${integration.name})...${NC}`);
            await fs.mkdir(integration.targetBase, { recursive: true });
            const commandsDir = path.join(rootDir, 'commands');
            if (existsSync(commandsDir)) {
                const files = await fs.readdir(commandsDir);
                for (const file of files) {
                    if (isInstallableMarkdown(file)) {
                        await fs.copyFile(path.join(commandsDir, file), path.join(integration.targetBase, file));
                        console.log(`  Installed: ${path.join(integration.targetBase, file)}`);
                    }
                }
            }
        }
    }

    // 10c. Slash Commands — Gemini CLI (.toml wrappers referencing .md files)
    if (shouldRun('gemini')) {
        const geminiInstalled = spawnSync(getCliCommand('gemini'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (geminiInstalled) {
            console.log(`${GREEN}[10c/14] Installing global slash commands (Gemini CLI)...${NC}`);
            const geminiCommandsBase = path.join(os.homedir(), '.gemini', 'commands');
            const geminiCommandsSubdir = path.join(geminiCommandsBase, 'agenfk');
            await fs.mkdir(geminiCommandsSubdir, { recursive: true });
            const commandsDir = path.join(rootDir, 'commands');
            if (existsSync(commandsDir)) {
                const files = await fs.readdir(commandsDir);
                for (const file of files) {
                    if (!isInstallableMarkdown(file)) continue;
                    const mdPath = path.join(commandsDir, file);
                    const mdContent = readFileSync(mdPath, 'utf8');
                    // Parse description from YAML frontmatter
                    let description = file.replace('.md', '');
                    const fmMatch = mdContent.match(/^---\s*\n([\s\S]*?)\n---/);
                    if (fmMatch) {
                        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
                        if (descMatch) description = descMatch[1].trim();
                    }
                    const tomlContent = `description = "${description}"\nprompt = """\n@${mdPath}\n\nARGUMENTS: $ARGUMENTS\n"""\n`;
                    // agenfk.md → agenfk.toml (top-level), others → agenfk/<name>.toml
                    let tomlDest;
                    if (file === 'agenfk.md') {
                        tomlDest = path.join(geminiCommandsBase, 'agenfk.toml');
                    } else {
                        // agenfk-plan.md → plan.toml
                        const subName = file.replace(/^agenfk-/, '').replace('.md', '');
                        tomlDest = path.join(geminiCommandsSubdir, `${subName}.toml`);
                    }
                    writeFileSync(tomlDest, tomlContent, 'utf8');
                    console.log(`  Installed: ${tomlDest}`);
                }
            }
        } else if (!onlyPlatform) {
            console.log(`${GREEN}[10c/14] Gemini CLI not found. Skipping Gemini slash commands.${NC}`);
        }
    }

    // 11b. Sweep macOS AppleDouble / .DS_Store artifacts left by earlier releases.
    // Every release up to v1.1.16-beta.4 was packaged with a bare `tar -czf` on
    // macOS, which emits a `._<name>` companion for each file carrying an
    // extended attribute — roughly half of every published tarball. The sync
    // filters no longer propagate them, but a machine that installed a polluted
    // release still has them on disk, where each `._agenfk-*` entry is surfaced
    // by Claude Code (and Cursor/Codex/Gemini/OpenCode) as a skill whose
    // description is mojibake binary, in the system prompt of every session.
    // Upgrading must clean them up rather than leave the user a manual `find`.
    //
    // MUST run after every sync step (8b/8e skills AND 10/11/10c commands), or
    // it heals only the dirs written before it. (CGLAB-94 / issue #163)
    console.log(`${GREEN}[11b/14] Sweeping stale macOS metadata artifacts...${NC}`);
    {
        // Shared dirs: only ever remove OUR litter. An AppleDouble twin is named
        // after the file it shadows, so ours are exactly `._agenfk*`; a bare
        // `._*` sweep would delete another tool's twin and its `.DS_Store` too.
        const sweepDirs = [
            path.join(os.homedir(), '.agents', 'skills'),
            path.join(os.homedir(), '.claude', 'skills'),
            path.join(os.homedir(), '.claude', 'commands'),
            path.join(os.homedir(), '.cursor', 'skills'),
            path.join(os.homedir(), '.codex', 'skills'),
            path.join(os.homedir(), '.gemini', 'skills'),
            path.join(os.homedir(), '.gemini', 'commands'),
            path.join(os.homedir(), '.gemini', 'commands', 'agenfk'),
            path.join(os.homedir(), '.config', 'opencode', 'skills'),
            path.join(os.homedir(), '.config', 'opencode', 'commands'),
        ];
        let swept = 0;
        for (const dir of sweepDirs) {
            if (!existsSync(dir)) continue;
            for (const entry of readdirSync(dir)) {
                if (!isMacMetadata(entry) || !isAgenfkOwnedEntry(entry)) continue;
                try {
                    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
                    swept++;
                } catch { /* ignore — best effort, never fail the install */ }
            }
        }
        // The install dir is entirely ours, so any `._*` there is ours to remove.
        // Guarded the same way as cleanStaleSrc(): a distributed tarball never
        // contains .git, so its presence means this is a dev checkout and the
        // tree is the developer's working copy, not ours to prune.
        const isDevCheckout = existsSync(path.join(rootDir, '.git'));
        const sweepTree = (dir) => {
            if (!existsSync(dir)) return;
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                const full = path.join(dir, entry.name);
                if (isMacMetadata(entry.name)) {
                    try { rmSync(full, { recursive: true, force: true }); swept++; } catch { /* ignore */ }
                } else if (entry.isDirectory()) {
                    sweepTree(full);
                }
            }
        };
        if (isDevCheckout) {
            console.log('  Skipping install-dir sweep (dev checkout detected: .git present).');
        } else {
            sweepTree(rootDir);
        }
        console.log(swept > 0 ? `  Removed ${swept} stale macOS metadata artifact(s)` : '  None found');
    }

    // 12. Mirror the shared hook scripts into ~/.agenfk/bin. This MUST happen
    // regardless of --only target: in-process plugins (OpenCode) and the pi
    // extension spawn these from ~/.agenfk/bin, so a targeted `--only=pi` /
    // `--only=opencode` install must still leave them present.
    const gatekeeperSource = path.join(rootDir, 'bin', 'agenfk-gatekeeper.mjs');
    const internalBinDir = path.join(agenfkHome, 'bin');
    await fs.mkdir(internalBinDir, { recursive: true });
    for (const script of ['agenfk-gatekeeper.mjs', 'agenfk-mcp-enforcer.mjs', 'agenfk-pr-hook.mjs', 'agenfk-test-guard.mjs']) {
        const src = path.join(rootDir, 'bin', script);
        if (existsSync(src)) {
            await fs.copyFile(src, path.join(internalBinDir, script));
        }
    }

    if (!onlyPlatform) {
        console.log(`${GREEN}[12/14] Installing agenfk-gatekeeper hook script...${NC}`);
        if (os.platform() === 'win32') {
            // Always write .cmd on Windows
            await fs.writeFile(`${gatekeeperDestBase}.cmd`, `@echo off\nnode "${gatekeeperSource}" %*`, 'utf8');
            // If MinGW, also write extension-less version for bash
            if (isMinGW) {
                await fs.writeFile(gatekeeperDestBase, `#!/bin/sh\nnode "${gatekeeperSource}" "$@"`, 'utf8');
                chmodSync(gatekeeperDestBase, 0o755);
            }
        } else {
            if (existsSync(gatekeeperSource)) {
                await fs.copyFile(gatekeeperSource, gatekeeperDestBase);
                chmodSync(gatekeeperDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${gatekeeperDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);

        // 12b. Install MCP enforcer hook script (blocks direct db/REST/CLI bypass routes)
        const enforcerSource = path.join(rootDir, 'bin', 'agenfk-mcp-enforcer.mjs');

        if (os.platform() === 'win32') {
            await fs.writeFile(`${enforcerDestBase}.cmd`, `@echo off\nnode "${enforcerSource}" %*`, 'utf8');
            if (isMinGW) {
                await fs.writeFile(enforcerDestBase, `#!/bin/sh\nnode "${enforcerSource}" "$@"`, 'utf8');
                chmodSync(enforcerDestBase, 0o755);
            }
        } else {
            if (existsSync(enforcerSource)) {
                await fs.copyFile(enforcerSource, enforcerDestBase);
                chmodSync(enforcerDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${enforcerDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);

        // 12d. Install agenfk-pr-hook into ~/.local/bin (the ~/.agenfk/bin mirror
        // is handled unconditionally above so --only installs are self-sufficient).
        const prHookSource = path.join(rootDir, 'bin', 'agenfk-pr-hook.mjs');

        if (os.platform() === 'win32') {
            await fs.writeFile(`${prHookDestBase}.cmd`, `@echo off\nnode "${prHookSource}" %*`, 'utf8');
            if (isMinGW) {
                await fs.writeFile(prHookDestBase, `#!/bin/sh\nnode "${prHookSource}" "$@"`, 'utf8');
                chmodSync(prHookDestBase, 0o755);
            }
        } else {
            if (existsSync(prHookSource)) {
                await fs.copyFile(prHookSource, prHookDestBase);
                chmodSync(prHookDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${prHookDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);

        // 12f. Install agenfk-test-guard into ~/.local/bin (asks the developer
        // before an EXISTING test is rewritten, skipped or deleted).
        const testGuardSource = path.join(rootDir, 'bin', 'agenfk-test-guard.mjs');

        if (os.platform() === 'win32') {
            await fs.writeFile(`${testGuardDestBase}.cmd`, `@echo off\nnode "${testGuardSource}" %*`, 'utf8');
            if (isMinGW) {
                await fs.writeFile(testGuardDestBase, `#!/bin/sh\nnode "${testGuardSource}" "$@"`, 'utf8');
                chmodSync(testGuardDestBase, 0o755);
            }
        } else {
            if (existsSync(testGuardSource)) {
                await fs.copyFile(testGuardSource, testGuardDestBase);
                chmodSync(testGuardDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${testGuardDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);
    }

    // 12c. Install Opencode MCP enforcer plugin
    if (shouldRun('opencode')) {
        const opencodePluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
        const opencodeInstalled = spawnSync(getCliCommand('opencode'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (existsSync(path.join(os.homedir(), '.config', 'opencode')) || opencodeInstalled) {
            await fs.mkdir(opencodePluginsDir, { recursive: true });
            const opencodeEnforcerSource = path.join(rootDir, 'bin', 'agenfk-mcp-enforcer-opencode.mjs');
            if (existsSync(opencodeEnforcerSource)) {
                await fs.copyFile(opencodeEnforcerSource, path.join(opencodePluginsDir, 'agenfk-mcp-enforcer.mjs'));
                console.log(`  Installed Opencode plugin: ${path.join(opencodePluginsDir, 'agenfk-mcp-enforcer.mjs')}`);
            }
            const opencodeGatekeeperSource = path.join(rootDir, 'bin', 'agenfk-gatekeeper-opencode.mjs');
            if (existsSync(opencodeGatekeeperSource)) {
                await fs.copyFile(opencodeGatekeeperSource, path.join(opencodePluginsDir, 'agenfk-gatekeeper.mjs'));
                console.log(`  Installed Opencode plugin: ${path.join(opencodePluginsDir, 'agenfk-gatekeeper.mjs')}`);
            }
            const opencodePrHookSource = path.join(rootDir, 'bin', 'agenfk-pr-hook-opencode.mjs');
            if (existsSync(opencodePrHookSource)) {
                await fs.copyFile(opencodePrHookSource, path.join(opencodePluginsDir, 'agenfk-pr-hook.mjs'));
                console.log(`  Installed Opencode plugin: ${path.join(opencodePluginsDir, 'agenfk-pr-hook.mjs')}`);
            }
        } else if (!onlyPlatform) {
            console.log(`  Opencode not found. Skipping Opencode plugin installation.`);
        }
    }

    // 12e. Install pi native extension (https://pi.dev). pi auto-loads single
    // .ts files from ~/.pi/agent/extensions/ via jiti — no build, no node_modules.
    // The extension delegates decisions to ~/.agenfk/bin/*.mjs (installed above).
    if (shouldRun('pi')) {
        if (!onlyPlatform) console.log(`${GREEN}[12e/14] Installing pi extension (~/.pi/agent/extensions)...${NC}`);
        const piHome = path.join(os.homedir(), '.pi');
        const piInstalled = spawnSync(getCliCommand('pi'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (existsSync(piHome) || piInstalled) {
            const piExtDir = path.join(piHome, 'agent', 'extensions');
            await fs.mkdir(piExtDir, { recursive: true });
            const piExtSource = path.join(rootDir, 'bin', 'agenfk-pi-extension.ts');
            if (existsSync(piExtSource)) {
                await fs.copyFile(piExtSource, path.join(piExtDir, 'agenfk.ts'));
                console.log(`  Installed pi extension: ${path.join(piExtDir, 'agenfk.ts')}`);
                console.log(`  pi enforcement is native (pre-edit gatekeeper + mcp-enforcer + PR-sizing reminder with deterministic model detection). Restart pi to load it.`);
            }
        } else if (!onlyPlatform) {
            console.log(`  pi not found. Skipping pi extension installation.`);
        }
    }

    // 7 (deferred). Configure Claude Code MCP via official CLI
    if (withMcp && shouldRun('claude')) {
        console.log(`${GREEN}[7/14] Configuring Claude Code MCP...${NC}`);
        try {
            const claudeCmd = getCliCommand('claude');
            const claudeCheck = spawnSync(claudeCmd, ['--version'], { stdio: 'ignore' });
            if (claudeCheck.status === 0) {
                console.log("  Registering AgenFK MCP server with Claude Code...");
                // Remove any existing registration first (ignore errors if not registered)
                spawnSync(claudeCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'ignore' });
                // Register with correct syntax: options, then -- to end variadic -e, then name + command
                const result = spawnSync(claudeCmd, [
                    'mcp', 'add',
                    '--transport', 'stdio',
                    '--scope', 'user',
                    '-e', `AGENFK_DB_PATH=${dbPath}`,
                    '--',
                    'agenfk',
                    cliDest, 'mcp'
                ], { stdio: 'inherit' });
                if (result.status === 0) {
                    console.log(`  ${GREEN}Registered agenfk MCP server (user scope).${NC}`);
                } else {
                    console.log(`  ${YELLOW}Warning: claude mcp add returned non-zero. Verify with: claude mcp get agenfk${NC}`);
                }
            } else if (!onlyPlatform) {
                console.log("  Claude Code CLI not found. Skipping Claude MCP configuration.");
            }
        } catch (e) {
            console.log("  Error checking Claude Code CLI. Skipping.");
        }
    }

    } // end if (!rulesOnly)

    // Helper: write rules to the active scope and clean up the opposite scope
    async function writeRulesWithScope(globalPath, projectPath, sourceFile, label) {
        const activePath = rulesScope === 'project' ? projectPath : globalPath;
        const oppositePath = rulesScope === 'project' ? globalPath : projectPath;

        if (!existsSync(sourceFile)) {
            if (!onlyPlatform) console.log(`  ${YELLOW}Warning: ${label} source not found. Skipping.${NC}`);
            return;
        }

        const rulesContent = await fs.readFile(sourceFile, 'utf8');

        // Write to active scope
        await fs.mkdir(path.dirname(activePath), { recursive: true });
        let existingContent = '';
        if (existsSync(activePath)) {
            existingContent = await fs.readFile(activePath, 'utf8');
            existingContent = existingContent.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
        }
        await fs.writeFile(
            activePath,
            (existingContent.trim() + '\n\n' + rulesContent.trim() + '\n').trim() + '\n',
            'utf8'
        );
        console.log(`  Written: ${activePath}`);

        // Clean up opposite scope — remove agenfk blocks
        if (existsSync(oppositePath)) {
            let oppositeContent = await fs.readFile(oppositePath, 'utf8');
            const cleaned = oppositeContent.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
            if (cleaned !== oppositeContent) {
                await fs.writeFile(oppositePath, cleaned.trim() ? cleaned.trim() + '\n' : '', 'utf8');
                console.log(`  Cleaned up opposite scope: ${oppositePath}`);
            }
        }
    }

    // Helper: copy rules file to the active scope and clean up the opposite scope
    async function copyRulesWithScope(globalPath, projectPath, sourceFile, label) {
        const activePath = rulesScope === 'project' ? projectPath : globalPath;
        const oppositePath = rulesScope === 'project' ? globalPath : projectPath;

        if (!existsSync(sourceFile)) {
            if (!onlyPlatform) console.log(`  ${YELLOW}Warning: ${label} source not found. Skipping.${NC}`);
            return;
        }

        await fs.mkdir(path.dirname(activePath), { recursive: true });
        await fs.copyFile(sourceFile, activePath);
        console.log(`  Written: ${activePath}`);

        // Clean up opposite scope
        if (existsSync(oppositePath)) {
            await fs.unlink(oppositePath);
            console.log(`  Cleaned up opposite scope: ${oppositePath}`);
        }
    }

    // 13. Write AgenFK workflow rules — CLAUDE.md
    if (shouldRun('claude')) {
        const scopeLabel = rulesScope === 'project' ? '.claude/CLAUDE.md (project)' : '~/.claude/CLAUDE.md (global)';
        console.log(`${GREEN}[13/14] Writing AgenFK workflow rules to ${scopeLabel}...${NC}`);
        const globalClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        const projectClaudeMd = path.join(projectDir, '.claude', 'CLAUDE.md');
        const claudeRulesSource = path.join(rootDir, 'clauderules', 'CLAUDE.md');
        await writeRulesWithScope(globalClaudeMd, projectClaudeMd, claudeRulesSource, 'clauderules/CLAUDE.md');
    }

    // 13b. Install Cursor workflow rules (.mdc)
    if (shouldRun('cursor')) {
        console.log(`${GREEN}[13b/14] Installing Cursor workflow rules (agenfk.mdc)...${NC}`);
        const cursorCmd = getCliCommand('cursor');
        const cursorMcpPath = getCursorMcpPath();
        const cursorConfigDir = path.dirname(cursorMcpPath);
        const cursorInstalled = existsSync(cursorConfigDir) ||
            spawnSync(cursorCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (cursorInstalled) {
            try {
                const globalCursorMdc = path.join(getCursorRulesDir(), 'agenfk.mdc');
                const projectCursorMdc = path.join(projectDir, '.cursor', 'rules', 'agenfk.mdc');
                const mdcSource = path.join(rootDir, 'cursorrules', 'agenfk.mdc');
                await copyRulesWithScope(globalCursorMdc, projectCursorMdc, mdcSource, 'cursorrules/agenfk.mdc');
            } catch (e) {
                console.error('  Error installing Cursor rules:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Cursor not found. Skipping Cursor rules installation.`);
        }
    }

    // 13c. Install Codex workflow rules (AGENTS.md)
    if (shouldRun('codex')) {
        console.log(`${GREEN}[13c/14] Installing Codex workflow rules (AGENTS.md)...${NC}`);
        const codexCmd = getCliCommand('codex');
        const codexInstalled = spawnSync(codexCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (codexInstalled) {
            try {
                const globalAgentsMd = path.join(os.homedir(), '.codex', 'AGENTS.md');
                const projectAgentsMd = path.join(projectDir, 'AGENTS.md');
                const codexRulesSource = path.join(rootDir, 'codexrules', 'AGENTS.md');
                await writeRulesWithScope(globalAgentsMd, projectAgentsMd, codexRulesSource, 'codexrules/AGENTS.md');
            } catch (e) {
                console.error('  Error installing Codex rules:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Codex not found. Skipping Codex rules installation.`);
        }
    }

    // 13d. Install Gemini CLI workflow rules (GEMINI.md)
    if (shouldRun('gemini')) {
        console.log(`${GREEN}[13d/14] Installing Gemini CLI workflow rules (GEMINI.md)...${NC}`);
        const geminiCmd = getCliCommand('gemini');
        const geminiInstalled = spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (geminiInstalled) {
            try {
                const globalGeminiMd = path.join(os.homedir(), '.gemini', 'GEMINI.md');
                const projectGeminiMd = path.join(projectDir, 'GEMINI.md');
                const geminiRulesSource = path.join(rootDir, 'geminirules', 'GEMINI.md');
                await writeRulesWithScope(globalGeminiMd, projectGeminiMd, geminiRulesSource, 'geminirules/GEMINI.md');
            } catch (e) {
                console.error('  Error installing Gemini CLI rules:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Gemini CLI not found. Skipping Gemini CLI rules installation.`);
        }
    }

    // 14. Register PreToolUse hook and MCP server in ~/.claude/settings.json
    if (shouldRun('claude')) {
        console.log(`${GREEN}[14/14] Configuring ~/.claude/settings.json...${NC}`);
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        let settings = {};
        if (existsSync(settingsPath)) {
            try {
                settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
            } catch (e) {}
        }
        
        // 12a. PreToolUse hook
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
            !JSON.stringify(entry).includes('agenfk-gatekeeper') &&
            !JSON.stringify(entry).includes('agenfk-mcp-enforcer') &&
            !JSON.stringify(entry).includes('agenfk-test-guard')
        );

        settings.hooks.PreToolUse.push({
            matcher: 'Edit|Write|NotebookEdit',
            hooks: [{ type: 'command', command: gatekeeperDest }]
        });

        // Test guard: asks the developer to choose (accept the test change vs fix
        // the code) before existing test code is rewritten, skipped or deleted.
        // Bash is matched too so `rm`/`git rm` of a test file is caught as well.
        settings.hooks.PreToolUse.push({
            matcher: 'Edit|Write|NotebookEdit|Bash',
            hooks: [{ type: 'command', command: `${testGuardDest} --client claude-code` }]
        });

        settings.hooks.PreToolUse.push({
            matcher: 'Bash|Read',
            hooks: [{ type: 'command', command: enforcerDest }]
        });

        // PostToolUse hook for PR sizing (fires on Bash so it can react to
        // `gh pr create` and `git push`).
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
            !JSON.stringify(entry).includes('agenfk-pr-hook')
        );
        settings.hooks.PostToolUse.push({
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `${prHookDest} --client claude-code` }]
        });

        // Remove legacy mcpServers key if present (MCP is now registered via `claude mcp add`)
        delete settings.mcpServers;

        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        console.log(`  Registered Pre/PostToolUse hooks in ${settingsPath}`);
    }

    // 14b. Configure PostToolUse hook for Codex CLI (~/.codex/hooks.json).
    // Codex requires events nested under a top-level `hooks` object and matches the
    // shell tool as `Bash`; buildCodexHooksConfig produces that shape and migrates
    // away any legacy top-level `PostToolUse` key that would crash Codex (CGLAB-12).
    if (shouldRun('codex')) {
        const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
        if (existsSync(path.dirname(codexHooksPath))) {
            let config = {};
            if (existsSync(codexHooksPath)) {
                try { config = JSON.parse(await fs.readFile(codexHooksPath, 'utf8')); } catch {}
            }
            config = buildCodexHooksConfig(config, `${prHookDest} --client codex`);
            await fs.writeFile(codexHooksPath, JSON.stringify(config, null, 2), 'utf8');
            console.log(`  Registered PostToolUse hook in ${codexHooksPath}`);
        }
    }

    // 14c. Configure AfterTool hook for Gemini CLI (~/.gemini/settings.json)
    if (shouldRun('gemini')) {
        const geminiSettingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
        if (existsSync(path.dirname(geminiSettingsPath))) {
            let settings = {};
            if (existsSync(geminiSettingsPath)) {
                try { settings = JSON.parse(await fs.readFile(geminiSettingsPath, 'utf8')); } catch {}
            }
            if (!settings.hooks) settings.hooks = {};
            if (!Array.isArray(settings.hooks.AfterTool)) settings.hooks.AfterTool = [];
            settings.hooks.AfterTool = settings.hooks.AfterTool.filter(e => !JSON.stringify(e).includes('agenfk-pr-hook'));
            settings.hooks.AfterTool.push({
                matcher: 'run_shell_command',
                command: `${prHookDest} --client gemini`,
            });
            await fs.writeFile(geminiSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
            console.log(`  Registered AfterTool hook in ${geminiSettingsPath}`);
        }
    }

    // 14d. Configure afterShellExecution hook for Cursor (~/.cursor/hooks.json, 1.7+)
    if (shouldRun('cursor')) {
        const cursorHooksPath = path.join(os.homedir(), '.cursor', 'hooks.json');
        if (existsSync(path.dirname(cursorHooksPath))) {
            let config = {};
            if (existsSync(cursorHooksPath)) {
                try { config = JSON.parse(await fs.readFile(cursorHooksPath, 'utf8')); } catch {}
            }
            if (!Array.isArray(config.afterShellExecution)) config.afterShellExecution = [];
            config.afterShellExecution = config.afterShellExecution.filter(e => !JSON.stringify(e).includes('agenfk-pr-hook'));
            config.afterShellExecution.push({
                command: `${prHookDest} --client cursor`,
            });
            await fs.writeFile(cursorHooksPath, JSON.stringify(config, null, 2), 'utf8');
            console.log(`  Registered afterShellExecution hook in ${cursorHooksPath}`);
        }
    }

    // BUG 174270e6: if a server was running before we replaced the files on
    // disk, restart it now so the running process actually executes the new
    // code. Without this, the upgrade silently lands on disk while the
    // pre-existing server keeps running its stale process image — visible to
    // users as "I upgraded but the Hub still shows the old version".
    //
    // We only do this when:
    //   - we detected a reachable server during the pre-install probe
    //   - the install isn't a single-platform integration-only run (--only-platform)
    //
    // Strategy: kill processes matching the server bin path, then spawn a
    // detached `agenfk up` so the user's foreground stays free. `agenfk up`
    // also handles the UI process and port persistence.
    // BUG 2f491181: restart when the probe saw a live server OR an explicit
    // out-of-band signal says one was running before `down` ran (the env flag
    // from the CLI, or the in-flight hub upgrade marker). `upgradeInFlight` is
    // already folded into wasReachableBeforeInstall above, but we keep it in
    // the guard so the intent is legible and the trigger is not a lone probe.
    if ((wasReachableBeforeInstall || upgradeInFlight) && !onlyPlatform) {
        console.log(`${BLUE}Restarting API server (was running on port ${preInstallServerPort} before upgrade)...${NC}`);
        // Delegate to `agenfk up`. It internally calls killPattern (which
        // already handles Windows via wmic and POSIX via ps/pgrep) and then
        // spawns a fresh server. This keeps the kill logic in one place.
        try {
            // --quiet: a fleet-upgrade auto-restart must not pop a new
            // browser tab on the user's machine. The dashboard is already
            // open in their existing window from before the upgrade.
            const child = spawn(
                'node',
                [path.join(rootDir, 'packages/cli/bin/agenfk.js'), 'restart', '--quiet'],
                { cwd: rootDir, detached: true, stdio: 'ignore' },
            );
            // BUG 2f491181: install.mjs is now the SOLE owner of the post-
            // upgrade restart (the CLI no longer fires a fallback `up`). A
            // detached, unref'd child with no 'error' listener would let an
            // async spawn failure (ENOENT, EAGAIN) escalate to an unhandled
            // error and crash install.mjs at the finish line. Handle it so we
            // degrade to printed guidance instead.
            child.on('error', (e) => {
                console.log(`${YELLOW}Could not auto-restart server: ${e?.message ?? e}${NC}`);
                console.log(`${YELLOW}Run \`agenfk restart\` manually to bring the new version online.${NC}`);
            });
            child.unref();
            console.log(`${GREEN}Server restart triggered (running in background).${NC}`);
        } catch (e) {
            console.log(`${YELLOW}Could not auto-restart server: ${e?.message ?? e}${NC}`);
            console.log(`${YELLOW}Run \`agenfk restart\` manually to bring the new version online.${NC}`);
        }
    }

    if (!onlyPlatform) {
        console.log(`${GREEN}Installation Complete.${NC}`);
        console.log("");
        console.log(`${YELLOW}=== Telemetry Notice ===${NC}`);
        console.log("AgenFK collects anonymous usage data (install count, commands used, feature adoption).");
        console.log("No personal data, file paths, or project content is ever collected.");
        console.log(`To opt out at any time: ${BLUE}agenfk config set telemetry false${NC}`);
        console.log("");
        console.log(`${BLUE}=== Usage Instructions ===${NC}`);
        console.log("1. Restart your AI editor/agent (Opencode, Cursor, Codex, and Gemini CLI need a restart to pick up the new MCP server; pi needs a restart to load its native extension).");
        console.log("2. Run 'node scripts/start-services.mjs' to start the API and Web UI.");
        console.log("3. Go to ANY project repository and type '/agenfk' (Standard) or '/agenfk-deep' (Multi-Agent) in your AI editor's prompt to initialize your project context and start the workflow.");
        console.log("4. Phase Commands (Agent Spawn): '/agenfk-plan', '/agenfk-code', '/agenfk-review', '/agenfk-test', '/agenfk-close'.");
        console.log("5. Run 'agenfk health' to verify your installation at any time.");
    } else {
        console.log(`${GREEN}Integration '${onlyPlatform}' Installation Complete.${NC}`);
        console.log(`Restart ${onlyPlatform} to pick up the changes.`);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
