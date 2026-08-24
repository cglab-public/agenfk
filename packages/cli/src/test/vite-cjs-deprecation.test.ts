/**
 * CGLAB-86 — "The CJS build of Vite's Node API is deprecated."
 *
 * That warning was emitted by Vite 5/6 whenever Vite's Node API was loaded
 * through a CJS require of the `vite` package. The repo no longer has that failure mode:
 * both UI workspaces are ESM (`"type": "module"`, so their `vite.config.ts`
 * is loaded as ESM) and the locked Vite is >= 7, where the CJS Node entry —
 * and therefore the deprecation warning — no longer exists.
 *
 * This suite pins that invariant so the warning cannot creep back in:
 *   - a downgrade of the locked Vite below 7 (back to a CJS-capable build),
 *   - a workspace losing `"type": "module"` while keeping a vite config,
 *   - any source file reintroducing a CJS require of Vite's Node API (see the
 *     CJS_REQUIRE_VITE pattern below — deliberately built from parts so this
 *     file cannot flag itself).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

// Built from parts so the pattern's own source text never contains the
// literal it hunts for (a doc comment mentioning it would self-flag).
const CJS_REQUIRE_VITE = new RegExp(`require\\(\\s*['"]vite['"]\\s*\\)`);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git']);

/** Collect source files (js/ts/mjs/cjs/cts/mts) under dir, skipping ignored dirs. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) out.push(...collectSourceFiles(full));
    } else if (/\.(js|ts|mjs|cjs|cts|mts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('CGLAB-86 — Vite CJS Node API deprecation guard', () => {
  it('both UI workspaces are ESM so their vite configs load through the ESM Node API', () => {
    for (const ws of ['packages/ui', 'packages/hub-ui']) {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, ws, 'package.json'), 'utf8'));
      expect(pkg.type, `${ws}/package.json must declare "type": "module"`).toBe('module');
      // and the workspace actually uses Vite (the invariant is only meaningful if it does)
      const usesVite =
        JSON.stringify(pkg.scripts ?? {}).includes('vite') ||
        (pkg.devDependencies ?? {}).vite ||
        (pkg.dependencies ?? {}).vite;
      expect(usesVite, `${ws} expected to use vite`).toBeTruthy();
    }
  });

  it('no source file loads Vite\'s Node API via CJS require', () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const file of collectSourceFiles(dir)) {
        const text = readFileSync(file, 'utf8');
        if (CJS_REQUIRE_VITE.test(text)) offenders.push(path.relative(ROOT, file));
      }
    };
    scan(path.join(ROOT, 'packages'));
    scan(path.join(ROOT, 'scripts'));
    scan(path.join(ROOT, 'bin'));
    // root-level config files (vite/vitest configs at the monorepo root)
    for (const f of readdirSync(ROOT)) {
      if (/\.(js|mjs|cjs|ts)$/.test(f) && CJS_REQUIRE_VITE.test(readFileSync(path.join(ROOT, f), 'utf8'))) {
        offenders.push(f);
      }
    }
    expect(offenders, `CJS require of Vite's Node API found in: ${offenders.join(', ')}`).toHaveLength(0);
  });

  it('the locked Vite is >= 7 (CJS Node entry and the deprecation warning were removed)', () => {
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const viteEntry = lock.packages?.['node_modules/vite'];
    expect(viteEntry, 'package-lock.json must pin node_modules/vite').toBeDefined();
    const major = Number(viteEntry.version.split('.')[0]);
    expect(major, `locked vite ${viteEntry.version} must be >= 7`).toBeGreaterThanOrEqual(7);
  });

  it('the installed vite (when present) matches the locked major', () => {
    const vitePkg = path.join(ROOT, 'node_modules', 'vite', 'package.json');
    if (!existsSync(vitePkg)) return; // clean checkout without install — skip
    const installed = Number(JSON.parse(readFileSync(vitePkg, 'utf8')).version.split('.')[0]);
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const locked = Number(lock.packages['node_modules/vite'].version.split('.')[0]);
    expect(installed, `installed vite major ${installed} must match lockfile major ${locked}`).toBe(locked);
  });
});
