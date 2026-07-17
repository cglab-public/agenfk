import { execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Hub-only distributable for hub-v* releases (CGLAB-8). Mirrors
// package-dist.mjs but ships ONLY what `agenfk-hub` needs at runtime: the hub
// server + its static UI + the @agenfk/core workspace dep, plus the root
// manifests so `npm ci --omit=dev` can resolve third-party deps for the
// non-Docker (npx / bare-node) path. Framework surfaces (cli, server, rules,
// installer) deliberately do NOT travel here — the framework tarball from the
// global v* release flow still ships everything, hub included.
// Guarded by packages/cli/src/test/hub-release-dist.test.ts.
async function run() {
    console.log('📦 Packaging AgenFK Hub Distributable...');

    // 1. Clean previous dists
    const distFile = 'agenfk-hub-dist.tar.gz';
    if (existsSync(path.join(rootDir, distFile))) {
        await fs.unlink(path.join(rootDir, distFile));
    }

    // 2. Ensure the hub and its deps are built (core → hub → hub-ui)
    console.log('  Building hub packages...');
    execSync('npm run build -w packages/core', { cwd: rootDir, stdio: 'inherit' });
    execSync('npm run build -w packages/hub', { cwd: rootDir, stdio: 'inherit' });
    execSync('npm run build -w packages/hub-ui', { cwd: rootDir, stdio: 'inherit' });

    // 3. Define files to include
    const include = [
        'package.json',
        'package-lock.json',
        'packages/core/package.json',
        'packages/core/dist/',
        'packages/hub/package.json',
        'packages/hub/dist/',
        'packages/hub/README.md',
        'packages/hub-ui/package.json',
        'packages/hub-ui/dist/',
        'HUB_ARCHITECTURE.md'
    ];

    // 4. Create the archive
    console.log(`  Creating ${distFile}...`);
    const includeStr = include.join(' ');
    execSync(`tar -czf ${distFile} ${includeStr}`, { cwd: rootDir, stdio: 'inherit' });

    console.log(`✨ Hub distributable created: ${path.join(rootDir, distFile)}`);
}

run().catch(err => {
    console.error('Hub packaging failed:', err);
    process.exit(1);
});
