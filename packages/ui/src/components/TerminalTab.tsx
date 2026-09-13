/**
 * The Terminal tab: a shell for the card you are looking at (CGLAB-169).
 *
 * Ties the three pieces together — which card, which agent, and the pane
 * itself. Deliberately thin: the picker owns detection, the pane owns the
 * session lifecycle, and this only decides what to show when there is no card.
 *
 * Keyed on the item id so switching cards tears the old session down and opens
 * a new one, rather than silently leaving you typing into the previous card's
 * worktree. That is the failure this component exists to prevent, and a key is
 * how React expresses it.
 */
import React from 'react';
import { AgentPicker, type AgentInfo } from './AgentPicker';
import { TerminalPane } from './TerminalPane';
import { EmptyState } from './EmptyState';

const AGENT_KEY = 'agenfk_terminal_agent';

interface DesktopTerminalApi {
  listAgents(): Promise<AgentInfo[]>;
}

export interface TerminalTabProps {
  /** The card whose worktree the terminal opens in. */
  readonly itemId: string | null;
  /** Injected in tests; in the app it comes from the preload bridge. */
  readonly listAgents?: () => Promise<AgentInfo[]>;
}

const bridgeListAgents = (): Promise<AgentInfo[]> => {
  const api = (window as unknown as { agenfkDesktop?: { terminal?: DesktopTerminalApi } })
    .agenfkDesktop?.terminal;
  return api ? api.listAgents() : Promise.resolve([]);
};

export function TerminalTab({ itemId, listAgents }: TerminalTabProps): React.ReactElement {
  const [agentId, setAgentId] = React.useState<string>(() => {
    // Remembered, because picking the same agent on every card is the common
    // case and re-choosing it each time is friction.
    try { return localStorage.getItem(AGENT_KEY) || 'claude'; } catch { return 'claude'; }
  });

  const chooseAgent = (next: string): void => {
    setAgentId(next);
    try { localStorage.setItem(AGENT_KEY, next); } catch { /* private mode */ }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-nav-surface px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-tertiary">Agent</span>
        <AgentPicker value={agentId} onChange={chooseAgent} listAgents={listAgents ?? bridgeListAgents} />
        {itemId && (
          <span className="ml-auto truncate font-mono text-[10px] text-ink-tertiary" title={itemId}>
            {itemId.slice(0, 8)}
          </span>
        )}
      </div>

      {itemId ? (
        // Keyed on both: changing either has to be a new session, not a reused
        // one pointed somewhere else.
        <TerminalPane key={`${itemId}:${agentId}`} itemId={itemId} agentId={agentId} />
      ) : (
        <div className="p-6">
          <EmptyState
            title="No card selected"
            body="Pick a card in the sidebar or on the board. Its terminal opens in that card's own worktree."
          />
        </div>
      )}
    </div>
  );
}
