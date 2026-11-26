/**
 * Story 76da75ea (INFRA-463), review round 1: bin/agenfk.js forwards the
 * installer flags, --no-hub among them. Asserted on the command the launcher
 * builds, since a text search of the launcher also matches the line that
 * reads the flag and proves nothing about forwarding.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error: plain ESM module without type declarations
import { installCommand } from '../../../../bin/install-command.mjs';

const root = path.resolve(__dirname, '../../../..');

describe('installCommand', () => {
  it('is the bare installer when no flag is given', () => {
    expect(installCommand(['node', 'agenfk.js'])).toBe('node scripts/install.mjs');
  });

  it('forwards --no-hub', () => {
    expect(installCommand(['node', 'agenfk.js', '--no-hub']).split(' ')).toContain('--no-hub');
  });

  it('forwards every installer flag it knows, in a fixed order', () => {
    const argv = ['node', 'agenfk.js', '--debuglog', '--no-hub', '--no-mcp', '--with-mcp', '--beta', '--rebuild'];
    expect(installCommand(argv)).toBe('node scripts/install.mjs --rebuild --beta --with-mcp --no-mcp --no-hub --debuglog');
  });

  it('does not forward a flag it does not know', () => {
    expect(installCommand(['node', 'agenfk.js', '--evil; rm -rf ~'])).toBe('node scripts/install.mjs');
  });

  it('is what bin/agenfk.js runs', () => {
    const src = fs.readFileSync(path.join(root, 'bin', 'agenfk.js'), 'utf8');
    expect(src).toMatch(/execSync\(installCommand\(process\.argv\)/);
  });
});
