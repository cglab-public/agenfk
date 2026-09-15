/**
 * One running process, drawn beneath the card it belongs to (1a1b8df6).
 *
 * The sessions rail was a flat list at the bottom of the sidebar showing work
 * that was ALREADY listed above it in the projects tree. Two places for one
 * fact, and they drifted - which is how the rail and the terminal came to
 * disagree earlier in this epic. So the process moves under its own card.
 *
 * THE TITLE IS GONE, and that is the change rather than a side effect: the
 * card is the line directly above, so repeating its title here is the same
 * string twice, inches apart. What is left is the two things the card cannot
 * say by itself - what state this process is in, and which agent it is.
 *
 * The width the title freed is spent on making the state a visible WORD. In
 * the rail those strings existed but only reached assistive tech; the dot
 * carried the state visually, and colour alone is the weakest way to carry it.
 *
 * STOP is the only hover control. The rail also offered BOARD because the rail
 * was somewhere else entirely; here "go to the card" would take you to the row
 * above the one you are pointing at. The two also used to overprint as
 * "19hBOARD" when the row was narrow.
 */
import React from 'react';
import { clsx } from 'clsx';
import { AgentIcon } from './AgentIcon';
import { DOT, STATE_LABEL, Spinner } from './sessionPresentation';
import type { SessionRow } from './SessionsRail';

export interface CardProcessRowProps {
  readonly row: SessionRow;
  /** Open this process. Absent while the row is only being displayed. */
  readonly onOpen?: (row: SessionRow) => void;
  /**
   * Stop it. Keyed by `runId`, never by `itemId`: a card can hold several
   * processes, and stopping has to reach exactly one of them.
   */
  readonly onStop?: (runId: string) => void;
}

export function CardProcessRow({ row, onOpen, onStop }: CardProcessRowProps): React.ReactElement {
  const label = STATE_LABEL[row.state];
  return (
    <div
      data-testid="process-row"
      // The state in the DOM as well as on screen, so a test and a stylesheet
      // can both ask without re-deriving it from a class name.
      data-state={row.state}
      className="group flex items-center gap-1.5 py-0.5 pl-1 pr-1 text-[11px]"
    >
      {row.state === 'running' ? (
        <Spinner />
      ) : (
        <span
          aria-hidden="true"
          className={clsx('mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT[row.state])}
        />
      )}

      <AgentIcon agentId={row.agentId} size={11} />

      <button
        type="button"
        onClick={onOpen ? () => onOpen(row) : undefined}
        disabled={!onOpen}
        /*
         * The agent's name and the state read as one phrase, which is why they
         * share a control rather than sitting in separate spans: "Claude Code,
         * Waiting for you" is the sentence, and splitting it makes a screen
         * reader announce two unrelated fragments.
         */
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-ink-secondary transition-colors enabled:hover:text-ink disabled:cursor-default"
      >
        <span className="shrink-0 font-medium">{row.agentLabel}</span>
        <span className="shrink-0 text-ink-tertiary">·</span>
        <span className="shrink-0 text-ink-tertiary">{label}</span>
        {/* What it is DOING beats what it is called, so this takes whatever
            width is left and is the first thing to be truncated. */}
        {row.state === 'running' && row.lastAction && (
          <span className="min-w-0 truncate font-mono text-[10px] text-ink-tertiary">
            {row.lastAction}
          </span>
        )}
      </button>

      {onStop && (
        <button
          type="button"
          onClick={() => onStop(row.runId)}
          aria-label={`Stop ${row.agentLabel}`}
          title={`Stop ${row.agentLabel}`}
          /*
           * Hidden until hover or focus, but never display:none - a control
           * that is not in the tab order cannot be reached without a pointer,
           * and stopping a runaway agent is the last thing that should require
           * one.
           */
          className="shrink-0 rounded px-1 font-mono text-[9px] uppercase text-ink-tertiary opacity-0 transition-opacity hover:text-rose-400 focus:opacity-100 group-hover:opacity-100"
        >
          Stop
        </button>
      )}
    </div>
  );
}
