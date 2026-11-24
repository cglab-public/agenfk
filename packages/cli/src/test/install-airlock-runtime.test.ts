/**
 * CGLAB-696 task 6: install and upgrade install the pinned smolvm where Airlock is in use, by
 * running `agenfk airlock install --if-enabled` with the CLI they just installed. A failure is
 * said, with how to retry; it never fails the install (the rest of AgEnFK works without it).
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
// @ts-expect-error - plain .mjs helper, no type declarations
import { installAirlockRuntime } from '../../../../scripts/install-helpers.mjs';

describe('installAirlockRuntime', () => {
  const root = '/opt/agenfk-system';

  it('runs the installed CLI\'s airlock install --if-enabled with this Node', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const warn = vi.fn();
    installAirlockRuntime({ run, rootDir: root, node: '/usr/bin/node', warn, detail: vi.fn() });
    expect(run).toHaveBeenCalledWith('/usr/bin/node', [path.join(root, 'packages/cli/bin/agenfk.js'), 'airlock', 'install', '--if-enabled'], expect.anything());
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes on what it said', () => {
    const detail = vi.fn();
    installAirlockRuntime({ run: () => ({ status: 0, stdout: 'Airlock: smolvm 1.32.4 installed at /x.\n', stderr: '' }), rootDir: root, node: 'node', warn: vi.fn(), detail });
    expect(detail).toHaveBeenCalledWith(expect.stringContaining('smolvm 1.32.4 installed'));
  });

  it('a failure is warned about, with what it said and how to retry, and the install goes on', () => {
    const warn = vi.fn();
    expect(() => installAirlockRuntime({ run: () => ({ status: 1, stdout: 'Airlock: the download\'s sha256 is wrong', stderr: '' }), rootDir: root, node: 'node', warn, detail: vi.fn() })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sha256 is wrong.*agenfk airlock install/s));
  });

  it('a skip because it could not tell whether Airlock is on (exit 3) is warned about, always shown (review 01a18d3a)', () => {
    const warn = vi.fn();
    installAirlockRuntime({ run: () => ({ status: 3, stdout: 'Airlock: could not tell whether Airlock is on (ECONNREFUSED), so smolvm was not installed. Install it with: agenfk airlock install\n', stderr: '' }), rootDir: root, node: 'node', warn, detail: vi.fn() });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not tell whether Airlock is on.*agenfk airlock install/s));
  });

  it('a CLI that cannot be run at all is warned about too', () => {
    const warn = vi.fn();
    installAirlockRuntime({ run: () => ({ status: null, error: new Error('spawn node ENOENT'), stdout: '', stderr: '' }), rootDir: root, node: 'node', warn, detail: vi.fn() });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENOENT.*agenfk airlock install/s));
  });
});
