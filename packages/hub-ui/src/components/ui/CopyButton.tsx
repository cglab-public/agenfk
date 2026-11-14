import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from './cn';

const RESET_MS = 2000;

/**
 * Copies `value` to the clipboard. It says "Copied" for a moment and goes
 * back to its label, and when the clipboard refuses (no permission, an
 * insecure origin) it says so, so the admin knows to select the value and
 * copy it by hand instead of pasting whatever was on the clipboard before.
 *
 * `iconOnly` keeps a row compact; `label` is then its accessible name.
 */
export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied', iconOnly = false, className }: {
  value: string;
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A new value (a freshly minted token) has not been copied yet.
  useEffect(() => { clearTimeout(timer.current); setState('idle'); }, [value]);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), RESET_MS);
    } catch {
      setState('failed');
    }
  };

  const copied = state === 'copied';
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? copiedLabel : label}
        title={iconOnly ? label : undefined}
        className="inline-flex items-center gap-1.5 text-small font-semibold text-accent-ink hover:underline"
      >
        {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
        {!iconOnly && (copied ? copiedLabel : label)}
      </button>
      {state === 'failed' && (
        <span role="status" className="text-caption text-status-warn-text">
          Couldn't copy — select it and copy by hand.
        </span>
      )}
    </span>
  );
}
