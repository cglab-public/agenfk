import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../ThemeContext';

/**
 * Shared look for the small buttons in the sidebar footer (theme toggle and
 * Sign out), so the two cannot drift apart visually. Callers append their own
 * hover accent.
 */
export const sidebarButtonClass =
  'flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-caption font-semibold border border-border-soft text-ink-secondary transition-colors';

/**
 * Sidebar light/dark switch.
 *
 * Labelling convention: the icon and the accessible name both describe the
 * DESTINATION mode ("Switch to dark mode" while currently light), which is
 * what users expect from a one-shot toggle, and the name contains the visible
 * "Dark"/"Light". No aria-pressed: "Switch to light mode, pressed" would give
 * two answers to one question.
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
      className={`${sidebarButtonClass} hover:bg-accent-fill hover:border-accent hover:text-accent-ink`}
    >
      {isDark ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
      <span>{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
