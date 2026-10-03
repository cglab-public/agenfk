// Node 26 ships a global `localStorage` that is undefined without
// --localstorage-file, and Vitest copies it onto the jsdom window, clobbering
// jsdom's own. Share the root shim rather than duplicating it — this suite has
// its own runner (packages/ui/vitest.config.ts) so the root setupFiles entry
// does not reach it.
import '../../../../vitest.setup';
import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';
import * as React from 'react';

/*
 * HOW LONG `findBy*` POLLS, which is not the test timeout (BUG 66dee896, and the
 * rotative flakiness in eb54e816).
 *
 * Testing Library waits 1s by default, and that number is independent of
 * vitest's `testTimeout` - the suite sets 20s precisely because the shell specs
 * render the whole cockpit and drive it with `byRole`, which recomputes an
 * accessible name for every candidate on every poll. So a spec whose budget is
 * 20s was giving its FIRST query 1s, and under load (a full-suite run, CI) the
 * sidebar had not rendered yet: "Unable to find role=button and name 'Expand
 * agenfk'", on a screen that was about to draw it.
 *
 * 5s: five times the default, and still a quarter of the suite's own ceiling, so
 * a genuinely missing element is still a failure rather than a hang.
 */
configure({ asyncUtilTimeout: 5000 });

// Also check global
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock HTMLElement.prototype.scrollTo
HTMLElement.prototype.scrollTo = vi.fn();
