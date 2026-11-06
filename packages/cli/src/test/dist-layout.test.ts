/**
 * TypeScript 6 migration guard: dist/ must stay flat.
 *
 * TS 6 no longer infers rootDir from the sources, so an emitting package
 * without `rootDir: "./src"` can emit dist/src/... and break every
 * `main`/`types`/`bin` target. This spec is config-only (no build needed):
 * it reads each tsc-built package's tsconfig.json and package.json.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PACKAGES_ROOT = path.join(REPO_ROOT, 'packages');
const NODE_TYPED = ['core', 'storage-sqlite', 'telemetry', 'hub', 'server', 'cli'];

/** JSON-with-comments parse: strips // and block comments outside of strings, and trailing commas. */
function parseJsonc(text: string): any {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true; out += c; i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c; i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const readJson = (file: string): any => parseJsonc(fs.readFileSync(file, 'utf8'));

/** Packages whose build script starts with tsc and whose tsconfig emits. */
function tscEmittingPackages(): string[] {
  return fs.readdirSync(PACKAGES_ROOT).filter(name => {
    const pkgFile = path.join(PACKAGES_ROOT, name, 'package.json');
    const tsconfig = path.join(PACKAGES_ROOT, name, 'tsconfig.json');
    if (!fs.existsSync(pkgFile) || !fs.existsSync(tsconfig)) return false;
    const build: string = readJson(pkgFile).scripts?.build ?? '';
    if (!/^tsc(\s|$|&)/.test(build)) return false;
    // `tsc -b && vite build` (ui, hub-ui) is a typecheck feeding a bundler: Vite owns their output, not tsc's dist layout.
    if (/vite/.test(build)) return false;
    return readJson(tsconfig).compilerOptions?.noEmit !== true;
  });
}

/** main, types and bin targets of a package.json that point into dist/. */
function distTargets(pkg: any): string[] {
  const bin = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values<string>(pkg.bin ?? {});
  return [pkg.main, pkg.types, ...bin]
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.replace(/^\.\//, ''))
    .filter(t => t.startsWith('dist/'));
}

function sourceFor(target: string): string {
  return 'src/' + target.slice('dist/'.length).replace(/\.d\.ts$/, '').replace(/\.js$/, '') + '.ts';
}

describe('dist-layout: the set of tsc-built packages', () => {
  it('is non-empty and includes core, storage-sqlite, telemetry, hub, server, cli', () => {
    const found = tscEmittingPackages();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(expect.arrayContaining(NODE_TYPED));
  });
});

describe.each(tscEmittingPackages())('dist-layout: package %s', name => {
  const dir = path.join(PACKAGES_ROOT, name);
  const tsconfig = readJson(path.join(dir, 'tsconfig.json'));
  const pkg = readJson(path.join(dir, 'package.json'));

  it(`${name}: tsconfig compilerOptions.rootDir is "./src" so dist/ stays flat`, () => {
    expect(tsconfig.compilerOptions?.rootDir).toBe('./src');
  });

  // TypeScript 6 defaults `types` to [], so @types/node must be listed by every package that emits with tsc.
  it(`${name}: tsconfig compilerOptions.types includes "node"`, () => {
    expect(tsconfig.compilerOptions?.types ?? []).toContain('node');
  });

  if (NODE_TYPED.includes(name)) {

    // Every main/types/bin target under dist/ must come from a same-path source file.
    // (Verified for all six packages: no mapping is impossible, so nothing is skipped.)
    // The `dist/src` check further down only runs when dist/ has been built; on a fresh checkout the
    // rootDir assertion above is the guard that matters.
    const targets = distTargets(pkg);
    it(`${name}: has at least one main/types/bin target under dist/`, () => {
      expect(targets.length).toBeGreaterThan(0);
    });
    for (const target of targets) {
      it(`${name}: ${target} maps to existing ${sourceFor(target)}`, () => {
        expect(fs.existsSync(path.join(dir, sourceFor(target)))).toBe(true);
      });
    }
  }

  it(`${name}: dist/src does not exist (no nested emit layout)`, () => {
    if (!fs.existsSync(path.join(dir, 'dist'))) return; // fresh clone: nothing built yet
    expect(fs.existsSync(path.join(dir, 'dist', 'src'))).toBe(false);
  });
});
