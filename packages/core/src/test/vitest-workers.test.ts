/**
 * The root vitest worker count (scripts/vitest-workers.mjs, GH-274 / #313).
 *
 * POSIX is pinned exactly: it was measured (18-CPU Linux, GH-274) and #313 must
 * not move it. Windows gets a rule of its own, because there a test's time goes
 * on waiting for process creation rather than on CPU; its exact ratio is chosen
 * by measurement, so only its bounds are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { resolveMaxWorkers } from '../../../../scripts/vitest-workers.mjs';

const POSIX_CASES: Array<[number, number]> = [
  [1, 2], [2, 2], [4, 2], [7, 2], [8, 2], [14, 3], [18, 4], [64, 16],
];
const CPU_COUNTS = POSIX_CASES.map(([cpus]) => cpus);

describe('resolveMaxWorkers — POSIX (unchanged from GH-274)', () => {
  for (const platform of ['linux', 'darwin']) {
    it(`${platform}: a quarter of the CPUs, at least 2`, () => {
      for (const [cpus, expected] of POSIX_CASES) {
        expect(resolveMaxWorkers({ platform, cpus }), `${platform} cpus=${cpus}`).toBe(expected);
      }
    });
  }

  it('any other non-Windows platform follows the POSIX rule', () => {
    for (const [cpus, expected] of POSIX_CASES) {
      expect(resolveMaxWorkers({ platform: 'freebsd', cpus }), `cpus=${cpus}`).toBe(expected);
    }
  });
});

describe('resolveMaxWorkers — win32 has its own rule (#313)', () => {
  it('never runs fewer workers than POSIX would on the same CPUs, and at least 2', () => {
    for (const cpus of CPU_COUNTS) {
      const win = resolveMaxWorkers({ platform: 'win32', cpus });
      const posix = resolveMaxWorkers({ platform: 'linux', cpus });
      expect(Number.isInteger(win), `cpus=${cpus}`).toBe(true);
      expect(win, `cpus=${cpus}`).toBeGreaterThanOrEqual(2);
      expect(win, `cpus=${cpus}`).toBeGreaterThanOrEqual(posix);
    }
  });

  it('runs more workers than POSIX on a typical 14-CPU Windows dev machine', () => {
    // Without a count where the rules differ, "its own rule" is not a rule.
    // 14 CPUs is the machine #313 was reported from (POSIX gives it 3).
    const win = resolveMaxWorkers({ platform: 'win32', cpus: 14 });
    expect(win).toBeGreaterThan(resolveMaxWorkers({ platform: 'linux', cpus: 14 }));
  });

  it('never exceeds the CPU count on a machine with at least 2 CPUs', () => {
    for (const cpus of CPU_COUNTS.filter((c) => c >= 2)) {
      expect(resolveMaxWorkers({ platform: 'win32', cpus }), `cpus=${cpus}`).toBeLessThanOrEqual(cpus);
    }
  });
});

describe('resolveMaxWorkers — win32 on a large machine (#313 review)', () => {
  // Measured up to 14 CPUs (8 workers was already slower than 6): the rule stays
  // inside that, and falls back to the POSIX quarter once that is higher.
  it('caps at 8 workers, but never below the POSIX rule', () => {
    expect(resolveMaxWorkers({ platform: 'win32', cpus: 20 })).toBe(8);
    expect(resolveMaxWorkers({ platform: 'win32', cpus: 32 })).toBe(8);
    expect(resolveMaxWorkers({ platform: 'win32', cpus: 64 })).toBe(16);
  });
});

describe('resolveMaxWorkers — a CPU count it cannot use', () => {
  // os.availableParallelism() should never return these, but a bad value must
  // not reach vitest as NaN/0 (it would fail the whole run, not one test).
  for (const platform of ['linux', 'darwin', 'win32']) {
    it(`${platform}: falls back to the minimum of 2`, () => {
      for (const cpus of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
        const got = resolveMaxWorkers({ platform, cpus });
        expect(Number.isInteger(got), `cpus=${cpus}`).toBe(true);
        expect(got, `cpus=${cpus}`).toBe(2);
      }
    });
  }
});
