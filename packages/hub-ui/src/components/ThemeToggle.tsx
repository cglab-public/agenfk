import { useTheme } from '../ThemeContext';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  const label = `Switch to ${nextTheme} theme`;

  return (
    <button
      data-testid="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-pressed={theme === 'dark' ? 'true' : 'false'}
      aria-label={label}
      title={label}
      className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-semibold border border-border-soft text-ink-secondary hover:bg-chip hover:text-ink transition-colors"
    >
      {theme === 'light' ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
      Switch to {nextTheme}
    </button>
  );
}