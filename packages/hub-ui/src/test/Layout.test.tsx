/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, afterEach, vi, beforeAll } from 'vitest';
import { Layout } from '../components/Layout';
import { ThemeProvider } from '../ThemeContext';

// Mock window.matchMedia (required by ThemeProvider)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock the api module so react-query hooks don't hit a real server
vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockRejectedValue(new Error('api not connected')),
    post: vi.fn().mockRejectedValue(new Error('api not connected')),
  },
  MeResponse: {},
}));

// Suppress React error boundaries during test teardown
const originalError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('ErrorBoundary')) return;
    originalError.apply(console, args);
  };
});

// Minimal QueryClient that doesn't keep retrying
const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

afterEach(() => {
  cleanup();
});

describe('Layout theme toggle', () => {
  it('renders a theme toggle button in the Layout aside', () => {
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ThemeProvider>
            <Layout>
              <div>Page content</div>
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // The toggle should exist as a button or element with aria-label "Toggle theme"
    const toggle = screen.queryByRole('button', { name: /toggle theme/i });
    expect(toggle).not.toBeNull();
  });
});
