/**
 * Regression test for the dist-packaging gap that let the #88 uninstaller fix
 * ship without ever reaching users via `agenfk upgrade`.
 *
 * `agenfk upgrade` only extracts agenfk-dist.tar.gz; it does NOT copy source
 * (unlike the `npx github:` path). So any script the uninstaller/installer needs
 * at runtime MUST be listed in scripts/package-dist.mjs's `include` array, or the
 * old copy from the original install survives forever.
 *
 * These assert (1) the uninstaller + its helpers are shipped, and (2) closure:
 * every shipped scripts/*.mjs has all of its local `./*.mjs` imports shipped too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const packageDist = readFileSync(path.join(ROOT, 'scripts', 'package-dist.mjs'), 'utf8');

// Extract the string literals inside the `const include = [ ... ]` array.
function parseIncludeList(src: string): string[] {
  const start = src.indexOf('const include = [');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// Local `./x.mjs` imports of a script file.
function localMjsImports(scriptRelPath: string): string[] {
  const src = readFileSync(path.join(ROOT, scriptRelPath), 'utf8');
  return [...src.matchAll(/(?:from|import)\s*['"](\.\/[A-Za-z0-9_-]+\.mjs)['"]/g)].map((m) =>
    path.posix.join(path.posix.dirname(scriptRelPath), m[1].replace(/^\.\//, ''))
  );
}

describe('package-dist.mjs — ships the uninstaller and its helpers', () => {
  const include = parseIncludeList(packageDist);

  it('includes scripts/uninstall.mjs so `agenfk upgrade` can deliver uninstaller fixes', () => {
    expect(include).toContain('scripts/uninstall.mjs');
  });

  it('includes the helper modules imported by the shipped scripts', () => {
    expect(include).toContain('scripts/uninstall-helpers.mjs');
    expect(include).toContain('scripts/install-helpers.mjs');
  });

  it('still ships the installer and service launcher', () => {
    expect(include).toContain('scripts/install.mjs');
    expect(include).toContain('scripts/start-services.mjs');
  });

  // Closure: any local ./*.mjs imported by a shipped script must also be shipped,
  // else the tarball-only `upgrade` path produces an ERR_MODULE_NOT_FOUND at runtime.
  it('ships every local .mjs import of every shipped script (import closure)', () => {
    const shippedScripts = include.filter((p) => /^scripts\/.+\.mjs$/.test(p));
    const missing: string[] = [];
    for (const script of shippedScripts) {
      for (const imp of localMjsImports(script)) {
        if (!include.includes(imp)) missing.push(`${script} imports ${imp} (not shipped)`);
      }
    }
    expect(missing).toEqual([]);
  });
});
