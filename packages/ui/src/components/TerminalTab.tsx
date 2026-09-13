/**
 * The Terminal tab: a shell for the card the user opened one on (CGLAB-169).
 *
 * Deliberately thin. The dialog decides which card and which agent; the pane
 * owns the session lifecycle. This only renders one or the other.
 *
 * The session is handed in whole rather than assembled here, and that is the
 * point: the agent and the auto-approve flag are decided once, at open time,
 * and must not change under a running process. A component that read them from
 * ambient state could swap the agent out from under a live shell.
 */
import React from 'react';
import { TerminalPane } from './TerminalPane';
import { EmptyState } from './EmptyState';

export interface TerminalSession {
  readonly itemId: string;
  readonly agentId: string;
  readonly autoApprove: boolean;
}

export interface TerminalTabProps {
  readonly session: TerminalSession | null;
}

export function TerminalTab({ session }: TerminalTabProps): React.ReactElement {
  if (!session) {
    return (
      <div className="p-6">
        <EmptyState
          title="No terminal open"
          body="Click a card in the sidebar to open a terminal on it. It runs in that card's own worktree, so the agent works on its branch and nothing else."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-nav-surface px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-tertiary">
          {session.agentId}
        </span>
        {session.autoApprove && (
          // Said out loud, permanently. A session running without the agent's
          // own permission prompts should never be indistinguishable from one
          // that has them.
          <span className="rounded-full bg-red-950/40 px-2 py-0.5 text-[10px] font-semibold text-red-300">
            permissions skipped
          </span>
        )}
        <span className="ml-auto truncate font-mono text-[10px] text-ink-tertiary" title={session.itemId}>
          {session.itemId.slice(0, 8)}
        </span>
      </div>

      {/* Keyed on the whole session: opening a terminal on a different card, or
          with a different agent, has to be a NEW process rather than a reused
          one pointed somewhere else. */}
      <TerminalPane
        key={`${session.itemId}:${session.agentId}:${session.autoApprove}`}
        itemId={session.itemId}
        agentId={session.agentId}
        autoApprove={session.autoApprove}
      />
    </div>
  );
}
