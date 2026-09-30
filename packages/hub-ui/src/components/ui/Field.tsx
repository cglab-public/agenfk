import { cloneElement, forwardRef, InputHTMLAttributes, isValidElement, ReactElement, ReactNode, SelectHTMLAttributes, useId } from 'react';
import { cn } from './cn';

// outline-hidden (not outline-none) keeps a transparent outline that
// forced-colors mode can paint; the box-shadow ring alone vanishes there.
export const controlClass = 'w-full px-3 py-2 rounded-lg border border-ink-tertiary/75 bg-surface text-ink text-sm placeholder:text-ink-tertiary '
  + 'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring aria-[invalid=true]:border-status-danger-text';

/** A text input. `icon` draws a leading glyph inside the box; the input stays the labelled control. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(function Input(
  { className, icon, ...rest }, ref,
) {
  if (!icon) return <input ref={ref} className={cn(controlClass, className)} {...rest} />;
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
      <input ref={ref} className={cn(controlClass, 'pl-9', className)} {...rest} />
    </div>
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(controlClass, className)} {...rest} />;
});

type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

/**
 * A labelled form control: wires label, hint and error to the child, which
 * must be the control itself (Input, Select, or any element taking id and
 * aria-*). The child's own id and aria-describedby are kept.
 */
export function Field({ label, hint, error, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement<ControlProps>;
  className?: string;
}) {
  const generated = useId();
  const own = isValidElement(children) ? children.props : {};
  const id = own.id ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [own['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  const extra: ControlProps = { id };
  if (describedBy) extra['aria-describedby'] = describedBy;
  if (error) extra['aria-invalid'] = true;
  const control = isValidElement(children) ? cloneElement(children, extra) : children;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-semibold text-ink-secondary">{label}</label>
      {control}
      {hint && <p id={hintId} className="text-xs text-ink-tertiary">{hint}</p>}
      {error && <p id={errorId} className="text-xs text-status-danger-text">{error}</p>}
    </div>
  );
}
