/**
 * How many vitest workers the root config runs (GH-274, #313).
 *
 * A pure function of the platform and the CPU count, so the rule can be tested
 * without faking `os`. vitest.config.ts calls it at the ROOT `test` block, so
 * `--maxWorkers` on the command line still overrides it for every project.
 *
 * POSIX: a quarter of the CPUs, at least 2. Measured on an 18-CPU Linux machine,
 * where a server/hub/cli worker is several CPUs' load (it spawns git and node
 * children by the dozen) and CPU is the bottleneck.
 *
 * win32: 40% of the CPUs, rounded, at least 2 and never more than the CPUs
 * (#313). On Windows much of each test's time is spent WAITING on process
 * creation (kernel + EDR sensor), not burning CPU, so more workers overlap that
 * wait. Measured on a 14-CPU Windows 11 machine (see vitest.config.ts): 6
 * workers was the fastest, 8 was already slower.
 *
 * A CPU count that is not a positive integer (0, negative, NaN, Infinity, a
 * fraction) gives the minimum of 2, so a bad value never reaches vitest as
 * NaN or 0.
 *
 * @param {{ platform: string, cpus: number }} opts
 * @returns {number}
 */
export function resolveMaxWorkers({ platform, cpus }) {
  const MIN = 2;
  if (!Number.isInteger(cpus) || cpus < 1) return MIN;
  if (platform === 'win32') return Math.max(MIN, Math.min(cpus, Math.round(cpus * 0.4)));
  return Math.max(MIN, Math.floor(cpus / 4));
}
