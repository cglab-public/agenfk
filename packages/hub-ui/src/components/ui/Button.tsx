import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

// One font weight per variant: two weight classes are settled by CSS source
// order, not class order, and the lighter one won.
const VARIANT: Record<ButtonVariant, string> = {
  // Solid brand teal, no gradient or glow: the page's one main action.
  // Disabled goes neutral: faded teal still read as a live main action. Full
  // opacity and a visible edge keep it a button, not grey text on the card.
  primary: 'bg-brand text-navy font-bold enabled:hover:bg-brand-light disabled:opacity-100 disabled:bg-canvas disabled:text-ink-tertiary disabled:border-ink-tertiary/40',
  secondary: 'bg-surface text-ink font-medium border-border-soft enabled:hover:border-accent enabled:hover:text-accent-ink',
  ghost: 'bg-transparent text-ink-secondary font-medium enabled:hover:bg-accent-fill enabled:hover:text-accent-ink',
  danger: 'bg-status-danger-bg text-status-danger-text font-semibold enabled:hover:border-status-danger-text',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-small gap-1',
  md: 'px-4 py-2 text-body gap-1.5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Button classes for places that style a <button> or <a> directly. */
export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string) => cn(
  'inline-flex items-center justify-center rounded-lg border border-transparent transition-colors',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  VARIANT[variant], SIZE[size], className,
);

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', type = 'button', className, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // Every variant carries a border (transparent unless it sets one), so
      // buttons side by side are the same height.
      className={buttonClass(variant, size, className)}
      {...rest}
    />
  );
});
