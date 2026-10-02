/**
 * Issue #201 — the test HOME sandbox can be forced to look like a real Windows
 * user profile: spaces and non-ASCII letters (e.g. `C:\Users\Fábio Teixeira`).
 * Runs on every OS; the Windows CI job turns it on via AGENFK_TEST_UNICODE_HOME.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-expect-error plain .mjs without types
import { testHomePrefix } from '../../../../scripts/vitest-home-pin.mjs';

describe('testHomePrefix', () => {
  it('is the plain ASCII prefix by default', () => {
    expect(testHomePrefix({})).toBe('agenfk-test-home-');
    expect(testHomePrefix({ AGENFK_TEST_UNICODE_HOME: '0' })).toBe('agenfk-test-home-');
  });

  it('contains a space and non-ASCII letters when AGENFK_TEST_UNICODE_HOME=1', () => {
    const p = testHomePrefix({ AGENFK_TEST_UNICODE_HOME: '1' });
    expect(p).toContain(' ');
    expect(p).toMatch(/[^\x00-\x7F]/);
  });

  it('yields a directory that can actually be created, written and read back as UTF-8', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), testHomePrefix({ AGENFK_TEST_UNICODE_HOME: '1' })));
    try {
      const file = path.join(dir, '.agenfk', 'config Fábio.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ nome: 'Fábio Téixeira — ação' }), 'utf8');
      const raw = fs.readFileSync(file);
      expect(raw[0]).not.toBe(0xef); // no UTF-8 BOM
      expect(JSON.parse(raw.toString('utf8')).nome).toBe('Fábio Téixeira — ação');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
