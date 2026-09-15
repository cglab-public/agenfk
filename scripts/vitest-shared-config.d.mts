/**
 * Types for the shared vitest config helper.
 *
 * The helper is plain ESM JavaScript so it can be imported by both
 * `vitest.config.ts` and per-package configs without a build step. Those configs
 * are type-checked (hub-ui's `tsc -b` covers its vite.config.ts), so without
 * this the import is an implicit `any` and the build fails under noImplicitAny.
 */
export interface SharedTestOptions {
  include: string[];
  environment?: string;
  parallel?: boolean;
}

/** The vitest `test` block shared by the root config and per-package configs. */
export function sharedTest(opts?: SharedTestOptions): Record<string, unknown> & {
  env: Record<string, string>;
  globals: boolean;
  environment: string;
  fileParallelism: boolean;
  sequence: { concurrent: boolean };
  testTimeout: number;
  hookTimeout: number;
  setupFiles: string[];
  include: string[];
  exclude: string[];
};

export const ALIAS: Record<string, string>;
export const sharedResolve: { alias: Record<string, string>; root: string };
