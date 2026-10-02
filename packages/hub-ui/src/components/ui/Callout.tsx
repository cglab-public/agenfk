import { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from './cn';
import { Tone, TONE_CLASS } from './Badge';

const ICON: Record<Tone, typeof Info> = { ok: CheckCircle2, warn: AlertTriangle, danger: XCircle, info: Info };
const WORD: Record<Tone, string> = { ok: 'Success:', warn: 'Warning:', danger: 'Error:', info: 'Note:' };

/**
 * A message about state. The icon and a spoken tone word carry it, not colour
 * alone. Not a live region unless `live` is set: a static message present on
 * page load must not interrupt a screen reader; one that appears in response to
 * an action (a failed save) should.
 */
export function Callout({ tone, title, children, action, live = 'off', className }: {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  live?: 'off' | 'polite' | 'assertive';
  className?: string;
}) {
  const Icon = ICON[tone];
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  return (
    <div role={role} className={cn('flex flex-wrap items-start gap-3 rounded-xl p-3 text-body', TONE_CLASS[tone], className)}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <span className="sr-only">{WORD[tone]}</span>
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', 'text-ink-secondary')}>{children}</div>}
      </div>
      {/* Under the text on a phone, beside it from sm: a shrink-0 action
          squeezed the text to a sliver at 390px. */}
      {action && <div className="basis-full pl-7 sm:basis-auto sm:pl-0">{action}</div>}
    </div>
  );
}
