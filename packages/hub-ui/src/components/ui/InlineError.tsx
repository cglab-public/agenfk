import { apiErrorText } from '../../apiError';
import { cn } from './cn';

/**
 * Why an admin action failed, said next to the control that failed. Takes the
 * raw error (a mutation's `error`, say) and shows the hub's own reason via
 * apiErrorText, never axios' "Request failed with status code 400". Renders
 * nothing while there is no error, so it can sit permanently beside a button.
 */
export function InlineError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return <p role="alert" className={cn('text-xs text-status-danger-text', className)}>{apiErrorText(error)}</p>;
}
