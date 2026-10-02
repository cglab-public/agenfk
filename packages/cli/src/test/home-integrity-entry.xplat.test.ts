/**
 * Issue #201 (review finding) — scripts/home-integrity.mjs decided "am I the
 * entry point?" with `new URL(import.meta.url).pathname`, which on Windows is
 * `/C:/...` and never equals process.argv[1]. The CLI body then never ran: both
 * `snapshot` and `verify` exited 0 printing nothing, so the CI steps that guard
 * the real ~/.agenfk were green no-ops.
 *
 * Running with no command must reach the CLI body (usage + exit 2) on every OS.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/home-integrity.mjs');

describe('home-integrity.mjs entry detection', () => {
  it('runs its CLI body when executed directly (prints usage, exits 2)', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', windowsHide: true });
    expect(r.stderr).toContain('usage: node scripts/home-integrity.mjs snapshot | verify');
    expect(r.status).toBe(2);
  });
});
