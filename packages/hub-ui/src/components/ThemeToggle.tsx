import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../ThemeContext';

/**
 * Light/dark theme toggle button. Rendered in the hub nav sidebar (Layout).
 * Shows a sun icon in dark mode (click to go light) and a moon icon in light
 * mode (click to go dark), mirroring the packages/ui KanbanBoard toggle.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors border border-transparent text-ink-secondary hover:text-ink hover:bg-chip hover:border-border-soft"
      title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
    >
      {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      {theme === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
