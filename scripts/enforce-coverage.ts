import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIN_COVERAGE = 80;

function run() {
  console.log('--- AgenFK Coverage Enforcement ---');
  
  try {
    // 1. Run tests with coverage reporters
    console.log('Running tests with coverage...');
    // Cleanup dist folders to prevent Vitest CJS errors
    const rootDir = process.cwd();
    const dists = [
      path.join(rootDir, 'packages', 'core', 'dist'),
      path.join(rootDir, 'packages', 'storage-json', 'dist'),
      path.join(rootDir, 'packages', 'cli', 'dist'),
      path.join(rootDir, 'packages', 'server', 'dist'),
      path.join(rootDir, 'packages', 'ui', 'dist'),
    ];
    for (const dist of dists) {
      if (fs.existsSync(dist)) {
        fs.rmSync(dist, { recursive: true, force: true });
      }
    }
    execSync('npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text --exclude="**/dist/**"', { stdio: 'inherit' });

    // 2. Read summary
    // Vitest usually outputs to ./coverage/coverage-summary.json
    const summaryPath = path.resolve(process.cwd(), 'coverage', 'coverage-summary.json');
    if (!fs.existsSync(summaryPath)) {
      console.error('❌ Error: coverage-summary.json not found.');
      process.exit(1);
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const total = summary.total;
    const stmts = total.statements.pct;
    const branch = total.branches.pct;
    const funcs = total.functions.pct;
    const lines = total.lines.pct;

    console.log(`\nOverall Coverage:`);
    console.log(`- Statements: ${stmts}%`);
    console.log(`- Branches: ${branch}%`);
    console.log(`- Functions: ${funcs}%`);
    console.log(`- Lines: ${lines}%`);

    if (stmts < MIN_COVERAGE) {
      console.error(`\n❌ FAILED: Overall coverage (${stmts}%) is below minimum threshold (${MIN_COVERAGE}%).`);
      process.exit(1);
    }

    // 3. Newly inserted code (Simplified check: verify modified files)
    console.log('\nChecking modified files coverage...');
    let filesOutput = '';
    try {
      filesOutput += execSync('git diff HEAD --name-only', { encoding: 'utf8' });
    } catch {}
    try {
      filesOutput += '\n' + execSync('git diff HEAD~1..HEAD --name-only', { encoding: 'utf8' });
    } catch {}

    const modifiedFiles = filesOutput
      .split('\n')
      .map(f => f.trim())
      .filter(f => f && (f.endsWith('.ts') || f.endsWith('.tsx')))
      .filter(f => !f.includes('.test.') && !f.includes('.spec.'));

    // Deduplicate
    const uniqueFiles = Array.from(new Set(modifiedFiles));

    let allModifiedPass = true;
    for (const file of uniqueFiles) {
      const fullPath = path.resolve(process.cwd(), file);
      // The summary key is usually the relative path or absolute path depending on vitest config
      // We look for a key that ends with the file path
      const fileKey = Object.keys(summary).find(k => k.endsWith(file));
      
      if (fileKey) {
        const filePct = summary[fileKey].statements.pct;
        if (filePct < MIN_COVERAGE) {
          console.error(`- ❌ ${file}: ${filePct}% (Below ${MIN_COVERAGE}%)`);
          allModifiedPass = false;
        } else {
          console.log(`- ✅ ${file}: ${filePct}%`);
        }
      } else {
        console.warn(`- ⚠️ ${file}: No coverage data found (possibly not imported in any test).`);
        allModifiedPass = false;
      }
    }

    if (!allModifiedPass) {
      console.error(`\n❌ FAILED: One or more modified files do not meet the ${MIN_COVERAGE}% coverage requirement.`);
      process.exit(1);
    }

    console.log(`\n✅ SUCCESS: All coverage requirements met!`);
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Error during coverage check:', err.message);
    process.exit(1);
  }
}

run();
