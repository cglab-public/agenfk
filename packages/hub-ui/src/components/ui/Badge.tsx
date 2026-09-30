import { HTMLAttributes } from 'react';
import { cn } from './cn';

export type Tone = 'ok' | 'warn' | 'danger' | 'info';
export type BadgeTone = Tone | 'accent' | 'neutral';

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-status-ok-text bg-status-ok-bg',
  warn: 'text-status-warn-text bg-status-warn-bg',
  danger: 'text-status-danger-text bg-status-danger-bg',
  info: 'text-status-info-text bg-status-info-bg',
};
const BADGE: Record<BadgeTone, string> = {
  ...TONE_CLASS,
  accent: 'text-accent-ink bg-accent-fill',
  neutral: 'text-ink-secondary bg-canvas border border-border-soft',
};

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold', BADGE[tone], className)}
      {...rest}
    />
  );
}
