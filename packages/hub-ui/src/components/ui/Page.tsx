import { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * The column every top-level hub page sits in. Capped so lines stay readable,
 * and left-aligned against the sidebar: centring it (`mx-auto`) opened a gap of
 * several hundred pixels between the rail and the page on a wide monitor.
 */
export function Page({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-page className={cn('max-w-[1200px] space-y-6', className)} {...rest} />;
}
