import { execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function run() {
    console.log('📦 Packaging AgenFK Distributable...');

    // 1. Clean previous dists
    const distFile = 'agenfk-dist.tar.gz';
    if (existsSync(path.join(rootDir, distFile))) {
        await fs.unlink(path.join(rootDir, distFile));
    }

    // 2. Ensure project is built
    console.log('  Building project...');
    execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

    // 3. Define files to include
    const include = [
        'package.json',
        'package-lock.json',
        'SKILL.md',
        'bin/',
        'scripts/start-services.mjs',
        'scripts/install.mjs',
        // The installer/uninstaller and their helper modules must travel in the
        // tarball — `agenfk upgrade` only extracts the dist and never copies
        // source, so anything omitted here can never be updated post-install
        // (e.g. the #88 uninstaller fix). Keep this in sync with every local
        // ./*.mjs import of the shipped scripts (enforced by dist-ships-uninstaller.test).
        'scripts/install-helpers.mjs',
        'scripts/uninstall.mjs',
        'scripts/uninstall-helpers.mjs',
        'commands/',
        'clauderules/',
        'codexrules/',
        'cursorrules/',
        'geminirules/',
        'skills/',
        'packages/core/package.json',
        'packages/core/dist/',
        'packages/cli/package.json',
        'packages/cli/dist/',
        'packages/cli/bin/',
        'packages/server/package.json',
        'packages/server/dist/',
        'packages/storage-sqlite/package.json',
        'packages/storage-sqlite/dist/',
        'packages/telemetry/package.json',
        'packages/telemetry/dist/',
        'packages/ui/package.json',
        // vite preview loads this at runtime. It contains the same-origin API
        // and WebSocket proxy used by installed dashboards.
        'packages/ui/vite.config.ts',
        'packages/ui/dist/',
        // flow-editor is a source-only TS package consumed by ui + hub-ui at
        // build time; its src/ must travel in the tarball so workspace resolution
        // doesn't fail (workspaces field references it).
        'packages/flow-editor/package.json',
        'packages/flow-editor/src/',
        'packages/hub/package.json',
        'packages/hub/dist/',
        'packages/hub-ui/package.json',
        'packages/hub-ui/dist/'
    ];

    // 4. Create the archive
    console.log(`  Creating ${distFile}...`);
    const includeStr = include.join(' ');
    execSync(`tar -czf ${distFile} ${includeStr}`, { cwd: rootDir, stdio: 'inherit' });

    console.log(`✨ Distributable created: ${path.join(rootDir, distFile)}`);
}

run().catch(err => {
    console.error('Packaging failed:', err);
    process.exit(1);
});
