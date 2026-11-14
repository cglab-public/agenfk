/**
 * @file GitHub #208 phase 2 — no spec may hard-code `/bin/sh` as its shell.
 *
 * `/bin/sh` does not exist for native Node on Windows, and 47 server specs
 * failing with `spawnSync /bin/sh ENOENT` is what kept the suite red there.
 * They now take their shell from `posixShell()` (test/helpers/posixShell.ts),
 * and this guard stops a new spec from copying the old fixture line back in.
 * A `#!/bin/sh` shebang inside a fixture file is fine: git runs hooks through
 * its own shell on every OS.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
// Absolute paths only: a bare `shell: 'bash'` is also a plain data field
// (install-flow-issue86 passes one to shellSourceHint), so it cannot be told
// apart from a spawn option by a line pattern.
const HARD_CODED = /shell\s*:\s*(['"`])(?:\/usr)?\/bin\/(?:ba)?sh\1/;

function specFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && full.split(path.sep).includes('test')) out.push(full);
  }
  return out;
}

describe('test shells', () => {
  it('the pattern catches the forms the old fixtures used', () => {
    expect(HARD_CODED.test("{ cwd: repo, shell: '/bin/sh' }")).toBe(true);
    expect(HARD_CODED.test('{ shell: "/bin/bash", encoding }')).toBe(true);
    expect(HARD_CODED.test("{ shell: '/usr/bin/bash' }")).toBe(true);
    expect(HARD_CODED.test("{ shell: '/usr/bin/sh' }")).toBe(true);
    expect(HARD_CODED.test("{ cwd, shell: posixShell() }")).toBe(false);
    expect(HARD_CODED.test("'#!/bin/sh\\nexit 1\\n'")).toBe(false);
  });

  it('no spec under packages/*/src passes shell: "/bin/sh"', () => {
    const offenders: string[] = [];
    for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
      const src = path.join(ROOT, 'packages', pkg, 'src');
      if (!fs.existsSync(src)) continue;
      for (const file of specFiles(src)) {
        if (file === __filename) continue;
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (HARD_CODED.test(line)) offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`);
        });
      }
    }
    expect(offenders, 'use posixShell() from test/helpers/posixShell.ts').toEqual([]);
  });
});
