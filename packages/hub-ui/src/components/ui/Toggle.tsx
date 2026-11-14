import { cn } from './cn';

/** An on/off switch. `label` is required: an unnamed switch is unusable with a screen reader. */
export function Toggle({ label, checked, onChange, disabled, id, className, 'aria-describedby': describedBy }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-describedby'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-10 h-5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        // Off stays visible (>= 3:1 on the card); the old soft-border track was 1.2:1.
        checked ? 'bg-accent' : 'bg-ink-tertiary',
        className,
      )}
    >
      <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-surface shadow-sm transition-transform', checked && 'translate-x-5')} />
    </button>
  );
}
