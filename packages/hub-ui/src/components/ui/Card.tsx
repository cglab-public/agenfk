import { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** A neutral surface. Colour belongs to what sits on it, never to the card. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('bg-surface border border-border-soft rounded-2xl p-5', className)} {...rest} />;
}

export function CardHeader({ title, description, actions, level = 2, id, className }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3 | 4;
  /** Put on the heading, for aria-labelledby on the section. */
  id?: string;
  className?: string;
}) {
  const H = (`h${level}`) as 'h2' | 'h3' | 'h4';
  return (
    <div className={cn('flex items-start justify-between gap-3 flex-wrap mb-4', className)}>
      <div className="min-w-0">
        <H id={id} className="text-sm font-semibold text-ink">{title}</H>
        {description && <p className="mt-0.5 text-xs text-ink-tertiary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
