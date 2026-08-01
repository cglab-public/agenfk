import { vi } from 'vitest';

/**
 * Installs a window.matchMedia stub reporting the given OS colour preference.
 *
 * Shared by ThemeContext.test.tsx and ThemeToggle.test.tsx — both need to
 * drive the prefers-color-scheme seed, and jsdom ships no matchMedia at all.
 */
export function mockPrefersColorScheme(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark && query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/** Clears persisted theme state and every marker the provider writes to <html>. */
export function resetThemeState() {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
}
