import { ReactNode } from 'react';
import { cn } from './cn';

/**
 * The opening of every dashboard: an eyebrow, the page title, a one-line
 * subtitle, and a toolbar slot on the right for page-wide controls such as the
 * period. Org and PR overview used to lay this out differently (the period in
 * the body on one, in the header on the other).
 */
export function PageHeader({ eyebrow, title, icon, subtitle, toolbar, className }: {
  eyebrow: string;
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  className?: string;
}) {
  return (
    <header data-page-header className={cn('flex items-end justify-between gap-4 flex-wrap', className)}>
      <div>
        <p className="eyebrow text-accent-ink">{eyebrow}</p>
        <h1 className="mt-1 text-display font-bold tracking-tight text-ink flex items-center gap-2">{icon}{title}</h1>
        {subtitle && <p className="mt-1 text-body text-ink-tertiary">{subtitle}</p>}
      </div>
      {toolbar && <div data-page-toolbar className="flex items-center gap-2 flex-wrap">{toolbar}</div>}
    </header>
  );
}
