/**
 * Open a terminal on a card (CGLAB-169).
 *
 * Three hazards shape this, none of them visual:
 *
 *  - **Re-entrancy.** Create is reachable by click and by ⌘↵, and launching an
 *    agent CLI takes a moment. Two presses would put two processes in the same
 *    worktree, both editing the same files. One in-flight flag guards every
 *    route in.
 *  - **Auto-approve.** The toggle disables the agent's own permission prompts.
 *    It defaults off, it is offered only where the agent can actually honour
 *    it, and it turns itself off when the chosen agent cannot — a toggle that
 *    reads "on" while the flag is silently dropped tells the user the rails are
 *    off when they are not.
 *  - **Dismissal.** Escape is refused while a spawn is in flight, or the main
 *    process is left holding a session nobody is waiting for.
 */
import React from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { AgentPicker, type AgentInfo } from './AgentPicker';

export interface NewTerminalRequest {
  readonly agentId: string;
  readonly autoApprove: boolean;
}

export interface NewTerminalDialogProps {
  /** Shown so the user can see which worktree they are about to work in. */
  readonly cardTitle: string;
  /**
   * The agent this card was last worked with, from the ITEM.
   *
   * Not a machine-wide preference: a single localStorage key meant opening card
   * B silently inherited card A's agent, and the choice reached no other
   * client. It is the same fact AgEnFK already records as `--model`/`--harness`
   * on a PR.
   */
  readonly defaultAgentId?: string;
  readonly onCreate: (req: NewTerminalRequest) => Promise<void>;
  readonly onClose: () => void;
  readonly listAgents: () => Promise<AgentInfo[]>;
}

export function NewTerminalDialog({
  cardTitle,
  defaultAgentId,
  onCreate,
  onClose,
  listAgents,
}: NewTerminalDialogProps): React.ReactElement {
  // Claude Code only as the first-run default, when the card has never been
  // worked. After that the card itself is the source of truth.
  const [agentId, setAgentId] = React.useState<string>(defaultAgentId || 'claude-code');
  // Never restored from storage. Unlike the agent, this is not a preference —
  // it is a per-run decision to take the safety rails off, and one the user
  // should have to make again each time.
  const [autoApprove, setAutoApprove] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    listAgents()
      .then(found => { if (!cancelled) setAgents(found); })
      .catch(() => { /* the picker shows its own fallback */ });
    return () => { cancelled = true; };
  }, [listAgents]);

  const chosen = agents.find(a => a.id === agentId);
  // Unknown until detection answers. Treating that as "supported" would flash
  // the toggle enabled and then disable it, which reads as a glitch.
  const supportsAutoApprove = chosen ? chosen.supportsAutoApprove : true;

  const chooseAgent = (next: string): void => {
    setAgentId(next);
    // Drop the request rather than carrying it into an agent that will ignore
    // it. A toggle left on would be a lie about what is running.
    if (!agents.find(a => a.id === next)?.supportsAutoApprove) setAutoApprove(false);
  };

  const create = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Both conditions, not just the toggle: an agent that cannot honour the
      // flag must never be asked to, or the request is silently dropped one
      // layer down and the user believes the rails are off.
      await onCreate({ agentId, autoApprove: autoApprove && supportsAutoApprove === true });
    } catch (e) {
      // Kept open with the message. resolveWorktree throws precisely so the
      // text names what to fix; closing would throw that away.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Not while a spawn is in flight: the session would be created with
      // nobody holding it.
      if (!busy) onClose();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void create();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex animate-[fadeIn_120ms_ease-out] items-center justify-center bg-black/50 p-4 motion-reduce:animate-none">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Open a terminal on ${cardTitle}`}
        onKeyDown={onKeyDown}
        className="w-full max-w-md animate-[popIn_140ms_cubic-bezier(0.2,0,0,1)] rounded-2xl border border-border-soft bg-nav-surface shadow-2xl motion-reduce:animate-none"
      >
        <div className="flex items-start gap-3 border-b border-border-soft px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-tertiary">
              Open terminal
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-ink" title={cardTitle}>
              {cardTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-ink-tertiary transition-colors hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-ink-secondary">Agent</label>
            <AgentPicker value={agentId} onChange={chooseAgent} listAgents={listAgents} />
          </div>

          <div>
            <button
              type="button"
              role="switch"
              aria-checked={autoApprove}
              aria-disabled={!supportsAutoApprove}
              aria-label="Dangerously skip permissions"
              onClick={() => { if (supportsAutoApprove) setAutoApprove(v => !v); }}
              className={clsx(
                'flex w-full items-center gap-3 text-left',
                supportsAutoApprove ? 'cursor-pointer' : 'cursor-default opacity-60',
              )}
            >
              <span
                className={clsx(
                  'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                  autoApprove ? 'bg-brand' : 'bg-canvas border border-border-soft',
                )}
              >
                <span
                  className={clsx(
                    'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
                    autoApprove ? 'translate-x-[18px]' : 'translate-x-0.5',
                  )}
                />
              </span>
              <span className="text-xs text-ink">Dangerously skip permissions</span>
            </button>
            {!supportsAutoApprove && (
              <p className="mt-1.5 pl-12 text-[11px] text-ink-tertiary">
                {chosen?.label ?? 'This agent'} does not support skipping permissions.
              </p>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-soft px-5 py-4">
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            className="rounded-lg px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
          >
            {busy ? 'Opening…' : 'Create'}
            {/* aria-hidden so the button's accessible name stays "Create".
                A screen reader announcing "Create command return" is noise —
                the shortcut is a visual affordance, not part of the label. */}
            {!busy && <span aria-hidden="true" className="font-mono text-[10px] opacity-70">⌘↵</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
