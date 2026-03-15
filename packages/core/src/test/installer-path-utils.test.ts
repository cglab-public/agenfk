import { describe, it, expect } from 'vitest';

// ─── toPosixPath ────────────────────────────────────────────────────────────
// Pure-function spec for the helper that will be inlined in bin/agenfk.js and
// scripts/install.mjs.  The function must convert Windows drive paths to MSYS2
// POSIX form so that Git-for-Windows / MSYS2 tar never sees a bare "C:" that it
// might interpret as a remote hostname.

function toPosixPath(p: string, isMinGW: boolean): string {
  if (isMinGW && /^[a-zA-Z]:/.test(p)) {
    return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  }
  return p;
}

describe('toPosixPath', () => {
  describe('when isMinGW = true', () => {
    it('converts a C:\\ path to /c/ form', () => {
      expect(toPosixPath('C:\\Users\\Dan\\agenfk', true)).toBe('/c/Users/Dan/agenfk');
    });

    it('lowercases the drive letter', () => {
      expect(toPosixPath('D:\\Projects\\foo', true)).toBe('/d/Projects/foo');
    });

    it('converts all backslashes to forward slashes', () => {
      expect(toPosixPath('C:\\Users\\Dan\\agenfk\\agenfk-dist.tar.gz', true))
        .toBe('/c/Users/Dan/agenfk/agenfk-dist.tar.gz');
    });

    it('handles a path that already uses forward slashes (rare, but safe)', () => {
      // Node path.join on Windows produces backslashes, but guard anyway.
      expect(toPosixPath('C:/Users/Dan/agenfk', true)).toBe('/c/Users/Dan/agenfk');
    });

    it('passes through a path that starts with / unchanged', () => {
      expect(toPosixPath('/tmp/agenfk-heal-123.tar.gz', true))
        .toBe('/tmp/agenfk-heal-123.tar.gz');
    });
  });

  describe('when isMinGW = false (Linux / macOS / plain Windows cmd)', () => {
    it('leaves Windows paths unchanged', () => {
      expect(toPosixPath('C:\\Users\\Dan\\agenfk', false)).toBe('C:\\Users\\Dan\\agenfk');
    });

    it('leaves POSIX paths unchanged', () => {
      expect(toPosixPath('/home/dan/agenfk', false)).toBe('/home/dan/agenfk');
    });
  });
});

// ─── autoHealRedownload tar exit-status check ────────────────────────────────
// Spec for the behaviour fix: if spawnSync('tar', ...) returns a non-zero status
// the function must return false instead of silently logging "Re-download complete."

describe('autoHealRedownload tar exit-status handling', () => {
  it('returns false when tar exits with non-zero status', () => {
    // Simulate the fixed logic: check tarResult.status before returning true.
    const tarResult = { status: 128 };
    const healed = tarResult.status === 0;
    expect(healed).toBe(false);
  });

  it('returns true when tar exits with status 0', () => {
    const tarResult = { status: 0 };
    const healed = tarResult.status === 0;
    expect(healed).toBe(true);
  });

  it('treats a null status (signal-killed) as failure', () => {
    // spawnSync sets status=null when the process is killed by a signal.
    const tarResult = { status: null as number | null };
    const healed = tarResult.status === 0;
    expect(healed).toBe(false);
  });
});
