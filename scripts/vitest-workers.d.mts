/**
 * Types for the vitest worker-count helper (scripts/vitest-workers.mjs), so
 * vitest.config.ts and the tests can import it without an implicit `any`.
 */
export function resolveMaxWorkers(opts: { platform: string; cpus: number }): number;
