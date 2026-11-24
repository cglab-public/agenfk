/**
 * Static guard (#349): shipped code must not call fs.cpSync. On Windows +
 * Node 22 it aborts the whole process natively (no catch, exit 3) when a path
 * holds a space and non-ASCII letters, which is every user home like
 * "C:\Users\José Ção\". bin/copy-tree.mjs is the plain-JS replacement.
 *
 * Scans bin/, scripts/ and packages/<pkg>/src, skipping tests, node_modules and
 * dist. Comments may name cpSync (they say why it is gone); any mention left in
 * code fails: a call, fs['cpSync'], an alias, a feature test like `if (fs.cpSync)`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const EXT = /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', '.git', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (EXT.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Blank out comments but keep newlines so reported line numbers stay true. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('no fs.cpSync in shipped code (#349)', () => {
  it('bin/, scripts/ and packages/*/src have no cpSync outside comments and tests', () => {
    const files = [
      ...walk(path.join(ROOT, 'bin')),
      ...walk(path.join(ROOT, 'scripts')),
      ...fs.readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => walk(path.join(ROOT, 'packages', d.name, 'src'))),
    ];
    expect(files.length).toBeGreaterThan(5); // guard: the scan really found shipped code

    const offenders: string[] = [];
    for (const file of files) {
      stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (/\bcpSync\b/.test(line)) offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'use bin/copy-tree.mjs instead of fs.cpSync').toEqual([]);
  });
});
