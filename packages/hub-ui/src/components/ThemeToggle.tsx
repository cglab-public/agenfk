import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../ThemeContext';

/**
 * Shared look for the small buttons in the sidebar footer (theme toggle and
 * Sign out), so the two cannot drift apart visually. Callers append their own
 * hover accent.
 */
export const sidebarButtonClass =
  'flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-semibold border border-border-soft text-ink-secondary transition-colors';

/**
 * Sidebar light/dark switch.
 *
 * Labelling convention: the icon and the accessible name both describe the
 * DESTINATION mode ("Switch to dark mode" while currently light), which is
 * what users expect from a one-shot toggle. `aria-pressed` carries the actual
 * current state for assistive tech.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={toggleTheme}
      title={label}
      aria-label={label}
      aria-pressed={isDark}
      className={`${sidebarButtonClass} hover:bg-chip hover:border-border-brand hover:text-accent-text`}
    >
      {isDark ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
      <span>{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
