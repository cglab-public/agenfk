import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

/**
 * Sidebar-style button that toggles between light and dark themes.
 * Shows a Moon icon when in light mode (tapping switches to dark) and
 * a Sun icon when in dark mode (tapping switches to light).
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  const label = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium text-ink-secondary border border-transparent hover:text-ink hover:bg-chip transition-colors"
    >
      {theme === 'light' ? (
        <Moon className="w-4 h-4" />
      ) : (
        <Sun className="w-4 h-4" />
      )}
    </button>
  );
}