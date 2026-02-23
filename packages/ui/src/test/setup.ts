import '@testing-library/jest-dom';
import { vi } from 'vitest';
import * as React from 'react';

// Shim React.act for environments where it's not correctly picked up (React 19 migration)
// Some versions of RTL/Vitest/React 19 combinations have issues with act availability.
if (!(React as any).act) {
  (React as any).act = (callback: any) => {
    return callback();
  };
}

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
