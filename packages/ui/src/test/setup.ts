// Node 26 ships a global `localStorage` that is undefined without
// --localstorage-file, and Vitest copies it onto the jsdom window, clobbering
// jsdom's own. Share the root shim rather than duplicating it — this suite has
// its own runner (packages/ui/vitest.config.ts) so the root setupFiles entry
// does not reach it.
import '../../../../vitest.setup';
import '@testing-library/jest-dom';
import { vi } from 'vitest';
import * as React from 'react';

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
