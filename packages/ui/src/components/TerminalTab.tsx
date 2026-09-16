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
import { tabIndicator, tabDotClass } from '../tabState';
import type { SessionState } from '../sessionRow';
import { agentLabel } from '../agentLabels';
import { WorktreePanel } from './WorktreePanel';
import { useGitStatus, type WorktreeView } from '../gitStatus';
import { X, Plus, GitBranch, FileDiff, Activity } from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { EmptyState } from './EmptyState';
import { AgentIcon } from './AgentIcon';
import { EditorIcon } from './EditorIcon';

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
  /**
   * Whether this session's process has ended.
   *
   * Set from the pane's own `pty:exit`, and the reason it lives on the session
   * rather than staying in the pane: the sessions rail was calling an exited
   * session "running", because the only signal it had was recency of OUTPUT —
   * and the exit message is itself output. A dead process is a FACT; it must
   * not have to age out of a liveness window.
   *
   * Per SESSION, never per card. Two agents can share a card, and one exiting
   * says nothing about the other — which is exactly why clearing liveness by
   * itemId would have been the wrong fix.
   */
  readonly exited?: boolean;
  /**
   * The code it exited WITH. Only meaningful alongside `exited`.
   *
   * Zero, or a user typing `exit`, is an ordinary end. Anything else is the
   * one failure this app can observe directly, and the rail keeps failures
   * however old — so losing this turned a crashed agent into a row that just
   * disappeared.
   */
  readonly exitCode?: number;
  /**
   * What the agent itself says it is doing, when it says anything.
   *
   * Undefined means NO OPINION, not idle. Two of our four agents publish
   * nothing on the terminal title — pi and gemini — and treating their silence
   * as rest would read as "asleep" for half the fleet. Where this is undefined
   * the rail falls back to output recency, which is wrong in the other
   * direction but at least is the behaviour that existed before.
   */
  readonly activity?: 'working' | 'blocked' | 'idle';
  /**
   * The state read off the rendered screen, for agents that publish no title.
   *
   * Kept apart from `activity` because the sources are not equivalent: one is
   * the agent's own word, the other is our reading of its drawing. A single
   * field would let whichever fired last win a disagreement in silence.
   */
  readonly screenActivity?: 'working' | 'blocked' | 'idle';
  /** Carried so the remembered row can be scoped to a project on restore. */
  readonly projectId?: string;
  /**
   * When this terminal was opened.
   *
   * Its own truth, not something derived at render: the rail's memo recomputes
   * whenever any card lights up, and stamping the time there reset every
   * terminal's elapsed display to "0s" on an unrelated card's event.
   */
  readonly openedAt: string;
  /** The conversation this tab holds, when the agent can be told one. */
  readonly agentSessionId?: string;
  /** True only for a tab being PUT BACK, never for one the user just opened. */
  readonly resume?: boolean;
  /** The server row remembering this tab, once it has been written. */
  readonly recordId?: string;
  /** The branch this card's worktree is on. */
  readonly branchName?: string | null;
  /** Shown as the breadcrumb root, so you know which repo you are in. */
  readonly projectName?: string;
}

export interface TerminalTabProps {
  readonly sessions: readonly TerminalSession[];
  /**
   * How each session is doing, keyed by session id (CGLAB-191).
   *
   * Passed in rather than computed here: `SessionRow.state` already holds this
   * and the rail already renders from it. A second opinion about whether an
   * agent is well is how the rail and the terminal came to disagree earlier in
   * this epic, and a disagreement is worse than either answer alone because
   * nothing on screen says which to believe.
   *
   * Optional, and absence is quiet rather than alarming: a tab exists from the
   * moment it is opened and its row appears when the agent first produces
   * something.
   */
  readonly sessionStates?: ReadonlyMap<string, SessionState>;
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** Opens the dialog for another terminal. */
  readonly onNew: () => void;
  /**
   * A pane reporting the conversation id its agent actually got.
   *
   * Routed through here rather than the pane talking to the server directly:
   * the shell owns what is remembered, and a component that both runs a
   * terminal and writes records is two jobs in one place.
   */
  readonly onSpawned?: (sessionId: string, agentSessionId: string | undefined) => void;
  /** A pane reporting that its terminal is producing output. */
  readonly onOutput?: (itemId: string) => void;
  /** A session's process ended. Carried by SESSION, never by card: two agents
   *  can share a card, and one exiting says nothing about the other. */
  /**
   * The process ended, and with WHICH code.
   *
   * The code used to be dropped here — `() => onExited?.(session.id)` swapped
   * the pane's only argument for the session id — so an agent that crashed was
   * indistinguishable from one the user typed `exit` into. Nothing downstream
   * could mark it failed, which left the rail's "a failure always stays" rule
   * guarding a state nothing could produce.
   */
  readonly onExited?: (sessionId: string, exitCode: number) => void;
  /** The agent published its state. By SESSION: two agents can share a card. */
  readonly onActivity?: (sessionId: string, activity: 'working' | 'blocked' | 'idle') => void;
  /** State read off the rendered screen. By SESSION, like the rest. */
  readonly onScreenActivity?: (sessionId: string, activity: 'working' | 'blocked' | 'idle') => void;
  /**
   * Editors installed on this machine, if any.
   *
   * Empty means no button at all: one that opens nothing and explains nothing
   * is worse than none, and the worktree path is already on screen in the
   * header for anyone who wants it.
   */
  readonly editors?: ReadonlyArray<{ id: string; label: string }>;
  /**
   * Open this CARD's worktree in that editor.
   *
   * A card and an editor id — never a path. The directory comes from the
   * server's record of which worktree the card owns, and the schemes the OS
   * can be asked to launch are a closed list in the main process.
   */
  readonly onOpenInEditor?: (itemId: string, editorId: string) => void;
  /**
   * Show the worktree panel beside the terminal.
   *
   * Off unless asked, because it polls git every few seconds and that is not
   * something to start doing on somebody's behalf.
   */
  readonly showWorktree?: boolean;
  /**
   * Whether the run feed is showing below the terminal.
   *
   * Passed in rather than owned here: the feed is a sibling of the terminal in
   * the shell's column, so the shell is the only thing that can say. Undefined
   * means the caller does not offer the control at all.
   */
  readonly runsOpen?: boolean;
  readonly onToggleRuns?: () => void;
}

/**
 * Whether the worktree panel is open, and on which list.
 *
 * `null` is closed, which is the third state the pair of buttons has to be
 * able to be in: neither list is showing, and neither button is pressed.
 *
 * Remembered, because a panel that reopens itself on the next launch was never
 * closed - and closing it is the point, since it is a fixed 288px the terminal
 * does not get back any other way. Same treatment the sidebar and the Runs
 * dock already get.
 */
const WORKTREE_PANEL_KEY = 'agenfk_worktree_panel';
/**
 * Is the worktree panel showing?
 *
 * Open or closed, and nothing else. It briefly stored WHICH list was showing,
 * from when the bar had two buttons; that choice belongs to the panel's own
 * tabs now. A stored value from that version is not a boolean, so it reads as
 * closed - which is the right landing place, because closed is the state with
 * a way out of it in one click.
 */
function readWorktreeOpen(): boolean {
  try { return JSON.parse(localStorage.getItem(WORKTREE_PANEL_KEY) ?? 'false') === true; }
  catch { return false; }
}

export function TerminalTab({
  sessions,
  sessionStates,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSpawned,
  onOutput,
  onExited,
  onActivity,
  onScreenActivity,
  editors,
  onOpenInEditor,
  showWorktree,
  runsOpen,
  onToggleRuns,
}: TerminalTabProps): React.ReactElement {
  // Seeded from storage in the initializer, so there is no first paint with
  // the panel open for someone who closed it.
  const [panelOpen, setPanelOpen] = React.useState<boolean>(() => readWorktreeOpen());
  const current = sessions.find(s => s.id === activeId);
  /*
   * Asked even with the panel CLOSED, which is what makes moving the counts
   * out of the panel worth anything: shut, these two numbers are the only
   * thing on screen saying the worktree has changes at all.
   *
   * Still gated on `showWorktree`, because that flag is a caller saying it
   * does not want a git poll every four seconds - and the counts are part of
   * the same feature, so they must not be what starts one.
   */
  const { data: git } = useGitStatus(current?.itemId ?? null, Boolean(showWorktree));

  /**
   * A TOGGLE, not open-only.
   *
   * Open-only would need a separate close control on the panel, which is two
   * controls for one piece of state. One button, one fact.
   */
  const toggleWorktree = React.useCallback(() => {
    setPanelOpen(cur => {
      const next = !cur;
      try { localStorage.setItem(WORKTREE_PANEL_KEY, JSON.stringify(next)); } catch { /* a lost preference, not a failure */ }
      return next;
    });
  }, []);

  // AFTER the hooks, never before: an early return above them would change how
  // many run between a render with sessions and one without, which React
  // rejects outright.
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

        {/* Its OWN group, separated from the editor button by a divider.
            "Open in VS Code" launches an application; these two change what is
            on screen, and three identical buttons in a row would read as three
            of the same kind of control.

            Buttons with `aria-pressed`, not a tablist. A tablist has to have a
            selected tab, and the state this pair spends most of its time in is
            the one where neither list is showing. */}
        {showWorktree && (
          <div
            role="group"
            aria-label="Worktree"
            className="flex shrink-0 items-center gap-1 border-r border-border-soft pr-2"
          >
            {/* ONE control, not two. Changed and staged are two halves of one
                question about one worktree, so splitting them into two buttons
                made a reader close one half to see the other. The button opens
                the panel; choosing between the halves happens inside it, where
                both counts are in view.

                The counts stay out here because with the panel shut they are
                the only sign the worktree has changes at all - which is the
                whole reason this moved into the bar. */}
            <button
              type="button"
              aria-pressed={panelOpen}
              onClick={toggleWorktree}
              title={panelOpen ? 'Hide the worktree files' : 'Show the worktree files beside the terminal'}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                panelOpen
                  ? 'border-brand bg-canvas font-semibold text-ink'
                  : 'border-border-soft text-ink-tertiary hover:border-brand hover:text-ink',
              )}
            >
              <FileDiff size={11} />
              {(git?.changed ?? 0)} / {(git?.staged ?? 0)}
            </button>

            {/* Runs in the same group, because it answers the same kind of
                question - "show me something beside the terminal" - and it is
                the only other thing competing for that space. Docked below it
                costs the terminal 192px whether or not anything is running,
                and until now the only way to reclaim that was to send Runs to
                its own screen, which is not the same as closing it. */}
            {onToggleRuns && (
              <button
                type="button"
                aria-pressed={runsOpen === true}
                onClick={onToggleRuns}
                title={runsOpen ? 'Hide the run feed' : 'Show the run feed below the terminal'}
                className={clsx(
                  'flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                  runsOpen
                    ? 'border-brand bg-canvas font-semibold text-ink'
                    : 'border-border-soft text-ink-tertiary hover:border-brand hover:text-ink',
                )}
              >
                <Activity size={11} />
                Runs
              </button>
            )}
          </div>
        )}

        {/* Here because this is where the user already is when they want it:
            looking at what the agent just did and wanting to see the files. */}
        {current && editors?.map(editor => (
          <button
            key={editor.id}
            type="button"
            onClick={() => onOpenInEditor?.(current.itemId, editor.id)}
            className="flex shrink-0 items-center gap-1.5 rounded border border-border-soft px-2 py-0.5 font-mono text-[10px] text-ink-secondary transition-colors hover:border-brand hover:text-ink"
          >
            <EditorIcon editorId={editor.id} />
            Open in {editor.label}
          </button>
        ))}
      </div>

      <div role="tablist" aria-label="Open terminals" className="flex shrink-0 items-stretch border-b border-border-soft bg-nav-surface">
        {sessions.map((session, index) => {
          const selected = session.id === activeId;
          /*
           * The AGENT and the position, not the card title.
           *
           * Every tab in a set is usually on the same card, so titling them
           * with the card repeats the same string across the whole strip and
           * distinguishes nothing — which is exactly what it did while the
           * restored tabs were also falling back to a raw uuid: three tabs,
           * one indistinguishable id. The card's name is in the header above,
           * where it belongs, said once.
           */
          const tabLabel = `${agentLabel(session.agentId)} ${index + 1}`;
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
                // The card stays in the tooltip: the strip says which agent,
                // hovering says which card.
                title={session.title}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {(() => {
                  /*
                   * The state of the pane you are NOT looking at. Without it,
                   * an agent that failed behind another tab is invisible until
                   * you click it - so failures are found by going looking, one
                   * tab at a time.
                   */
                  const ind = tabIndicator(sessionStates?.get(session.id));
                  if (!ind.state) return null;
                  return (
                    <span
                      data-testid="tab-state"
                      data-state={ind.state}
                      title={ind.label ?? undefined}
                      className={clsx('shrink-0 rounded-full', tabDotClass(ind.state),
                        // Urgent states are bigger as well as louder: colour
                        // alone is not a signal everybody receives.
                        ind.urgent ? 'h-2 w-2' : 'h-1.5 w-1.5')}
                    />
                  );
                })()}
                <AgentIcon agentId={session.agentId} size={13} />
                <span className={clsx('truncate text-xs', selected ? 'text-ink' : 'text-ink-secondary')}>
                  {tabLabel}
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
      {/* Panes and the worktree panel share the row, so the panel sits beside
          what it describes rather than under it. min-w-0 on the panes: without
          it a long line of terminal output refuses to shrink and pushes the
          panel off screen. */}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
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
            agentSessionId={session.agentSessionId}
            resume={session.resume}
            onSpawned={agentSessionId => onSpawned?.(session.id, agentSessionId)}
            onOutput={() => onOutput?.(session.itemId)}
            onExited={code => onExited?.(session.id, code)}
            onActivity={a => onActivity?.(session.id, a)}
            onScreenActivity={a => onScreenActivity?.(session.id, a)}
          />
        </div>
      ))}
      </div>

      {/* Asks about the session you are LOOKING at, not all of them: the panel
          answers "what has this agent touched", and that question only has a
          meaning for one worktree at a time.

          Absent rather than hidden when closed, which is the whole point: it
          is a fixed 288px of the row, and hiding it would leave the terminal
          exactly as narrow as before. Nothing is lost by unmounting it - it
          holds a query, not a process, and the query is the shared one the
          bar's counts keep alive anyway. */}
      {showWorktree && panelOpen && (
        <WorktreePanel itemId={current?.itemId ?? null} />
      )}
      </div>
    </div>
  );
}
