/**
 * jest-dom 7.0.1 augments vitest's `Assertion<T = any>` — the vitest 4 shape.
 * vitest 5 changed it to `Assertion<R extends void | Promise<void>, T>`, so the
 * interface merge fails and the matchers disappear from `expect(...)` (only
 * visible under `tsc`, not at runtime). This re-declares the augmentation with
 * the vitest 5 shape. Drop this file once jest-dom ships a vitest-5-aware
 * `types/vitest.d.ts`.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<R extends void | Promise<void> = void, T = unknown>
    extends TestingLibraryMatchers<any, R> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
