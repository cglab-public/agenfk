/**
 * The Terminal tab: N open terminals, one per card (CGLAB-169).
 *
 * The load-bearing rule is that **every pane stays mounted**. Unmounting a
 * TerminalPane kills its session and destroys its scrollback, so a tab bar that
 * swapped panes in and out would mean switching tabs silently killed the agent
 * you switched away from — the exact catastrophe the panel-level `hidden`
 * already exists to prevent one level up. Inactive panes are hidden, never
 * removed.
 *
 * That also makes "click a card that already has a terminal" free: it is a
 * selection, not a spawn.
 */
import React from 'react';
import { clsx } from 'clsx';
import { X, Plus, GitBranch } from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { EmptyState } from './EmptyState';
import { AgentIcon } from './AgentIcon';

export interface TerminalSession {
  /** Stable per open terminal, not per card: a card may have more than one. */
  readonly id: string;
  readonly itemId: string;
  readonly title: string;
  readonly agentId: string;
  readonly autoApprove: boolean;
  /**
   * Whether this session runs inside tmux.
   *
   * Listed here for the same reason as autoApprove: this type is the contract
   * between the shell and the pane, and a field the shell sets but this type
   * omits is silently dropped on the way through. That is precisely how it was
   * lost the first time — the shell computed it, the pane never received it,
   * and the setting looked wired end to end while doing nothing.
   */
  readonly persist: boolean;
  /** The branch this card's worktree is on. */
  readonly branchName?: string | null;
  /** Shown as the breadcrumb root, so you know which repo you are in. */
  readonly projectName?: string;
}

export interface TerminalTabProps {
  readonly sessions: readonly TerminalSession[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** Opens the dialog for another terminal. */
  readonly onNew: () => void;
}

export function TerminalTab({
  sessions,
  activeId,
  onSelect,
  onClose,
  onNew,
}: TerminalTabProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No terminal open"
          body="Click a card in the sidebar to open a terminal on it. It runs in that card's own worktree, so the agent works on its branch and nothing else."
        />
      </div>
    );
  }

  const current = sessions.find(s => s.id === activeId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Which worktree you are typing into. With several terminals open this
          is the only thing on screen that distinguishes them, and sending a
          command to the wrong branch is a real and expensive mistake. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-nav-surface px-3 py-1.5 text-xs">
        <span className="truncate text-ink-secondary">
          {current?.projectName && <span className="text-ink-tertiary">{current.projectName} / </span>}
          {current?.title}
        </span>
        {current?.branchName ? (
          <span
            title={current.branchName}
            data-testid="session-branch"
            className="ml-auto flex min-w-0 shrink items-center gap-1.5 rounded-lg border border-border-soft bg-canvas px-2 py-0.5"
          >
            <GitBranch size={11} className="shrink-0 text-ink-tertiary" />
            <span className="truncate font-mono text-[11px] text-ink">{current.branchName}</span>
          </span>
        ) : (
          // Said, not hidden. A card with no branch yet is a worktree that has
          // not been created, and that is worth knowing BEFORE you type.
          <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">no branch yet</span>
        )}
      </div>

      <div role="tablist" aria-label="Open terminals" className="flex shrink-0 items-stretch border-b border-border-soft bg-nav-surface">
        {sessions.map(session => {
          const selected = session.id === activeId;
          return (
            <div
              key={session.id}
              className={clsx(
                'group flex max-w-[220px] items-center gap-2 border-r border-border-soft px-3 py-2',
                selected ? 'bg-canvas' : 'hover:bg-canvas/50',
              )}
            >
              <button
                role="tab"
                aria-selected={selected}
                onClick={() => onSelect(session.id)}
                title={session.title}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <AgentIcon agentId={session.agentId} size={13} />
                <span className={clsx('truncate text-xs', selected ? 'text-ink' : 'text-ink-secondary')}>
                  {session.title}
                </span>
                {session.autoApprove && (
                  // Marked on the tab itself, not only inside the pane: with
                  // several terminals open, which one is running without the
                  // agent's own prompts has to be visible without switching to
                  // it.
                  <span title="Permissions skipped" className="shrink-0 text-[10px] text-red-400">●</span>
                )}
              </button>
              <button
                onClick={() => onClose(session.id)}
                aria-label={`Close terminal on ${session.title}`}
                className="shrink-0 rounded p-0.5 text-ink-tertiary opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          onClick={onNew}
          aria-label="New terminal"
          className="flex shrink-0 items-center px-3 text-ink-tertiary transition-colors hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* All of them, always. Hiding is a style; unmounting kills a process. */}
      {sessions.map(session => (
        <div
          key={session.id}
          hidden={session.id !== activeId}
          className="min-h-0 flex-1"
        >
          <TerminalPane
            itemId={session.itemId}
            agentId={session.agentId}
            autoApprove={session.autoApprove}
            persist={session.persist}
          />
        </div>
      ))}
    </div>
  );
}
