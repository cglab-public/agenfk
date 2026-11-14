import { execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTarball } from './package-helpers.mjs';
import { DIST_INCLUDE } from './dist-manifest.mjs';

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

    // 3. Files to include: scripts/dist-manifest.mjs
    const include = DIST_INCLUDE;

    // 4. Create the archive
    console.log(`  Creating ${distFile}...`);
    createTarball({ cwd: rootDir, outFile: distFile, include });

    console.log(`✨ Distributable created: ${path.join(rootDir, distFile)}`);
}

run().catch(err => {
    console.error('Packaging failed:', err);
    process.exit(1);
});
