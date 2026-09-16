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
 * NO HOVER CONTROLS AT ALL, and that is deliberate on both counts.
 *
 * BOARD went first: the rail offered it because the rail was somewhere else
 * entirely, and here "go to the card" would take you to the line directly
 * above the one you are pointing at.
 *
 * STOP went second, reported by the user. It did not stop anything - the
 * handler behind it looked the run up among the open sessions and CLOSED the
 * terminal. A label that promises to interrupt an agent and instead discards
 * the session and its scrollback is worse than no control, because the moment
 * somebody reaches for it is the moment they least want to lose the output.
 *
 * Stopping an agent is a real need. It is a different control with different
 * semantics - signal the process, keep the terminal - and it belongs to its
 * own card rather than being smuggled in under a label that already means
 * something else.
 */
import React from 'react';
import { clsx } from 'clsx';
import { AgentIcon } from './AgentIcon';
import { DOT, STATE_LABEL, Spinner } from './sessionPresentation';
import type { SessionRow } from '../sessionRow';
import { nextAction, nextActionCommand } from '../nextAction';
import { stallWarning } from '../stallWarning';

export interface CardProcessRowProps {
  readonly row: SessionRow;
  /** Open this process. Absent while the row is only being displayed. */
  readonly onOpen?: (row: SessionRow) => void;
}

export function CardProcessRow({ row, onOpen }: CardProcessRowProps): React.ReactElement {
  const label = STATE_LABEL[row.state];
  return (
    <div
      data-testid="process-row"
      // The state in the DOM as well as on screen, so a test and a stylesheet
      // can both ask without re-deriving it from a class name.
      data-state={row.state}
      className="flex items-center gap-1.5 py-0.5 pl-1 pr-1 text-[11px]"
    >
      {row.state === 'running' ? (
        <>
          <Spinner />
          {/* The state still lives on a STATIC node, so assistive tech and any
              test can read it without depending on the animation frame. Copied
              from the rail deliberately: dropping it here would have made the
              running state readable only by watching. */}
          <span
            data-testid="session-dot"
            data-state="running"
            aria-label={STATE_LABEL.running}
            role="img"
            className="sr-only"
          />
        </>
      ) : (
        <span
          data-testid="session-dot"
          data-state={row.state}
          aria-label={STATE_LABEL[row.state]}
          role="img"
          className={clsx('mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT[row.state])}
        />
      )}

      <AgentIcon agentId={row.agentId} size={11} />

      <button
        type="button"
        data-testid="process-open"
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
        {(() => {
          /*
           * Long silence, SAID and never acted on (CGLAB-201).
           *
           * It sits inside the running row rather than beside it, because it
           * is a qualifier on "running" and not a state of its own - a
           * separate badge would read as a fourth thing to learn and invite
           * somebody to act on it.
           */
          const stall = stallWarning({ state: row.state, /*
             * startedAt, because that is the only time SessionRow carries.
             * It is the honest floor: an agent silent since it began is the
             * clearest case, and a row that tracked its own last output would
             * be a second liveness source competing with the one that exists.
             */
            lastSeenAt: row.startedAt });
          if (!stall.warn) return null;
          return (
            <span
              data-testid="stall-warning"
              title={stall.text ?? undefined}
              className="shrink-0 font-mono text-[10px] text-ink-tertiary opacity-70"
            >
              quiet {stall.quietMinutes}m
            </span>
          );
        })()}
      </button>

      {(() => {
        /*
         * The command that would resolve this one (CGLAB-200).
         *
         * Shown, never run. The row said what state the agent is in and left
         * the person to work out the move; this removes the deduction without
         * taking the decision away from anybody.
         *
         * Absent on a healthy row rather than empty: a suggestion on every row
         * is how the useful ones stop being read.
         */
        const action = nextAction({ itemId: row.itemId, state: row.state, hasTerminal: row.hasTerminal });
        const command = nextActionCommand(action);
        if (!command) return null;
        return (
          <span
            data-testid="next-action"
            data-state={row.state}
            /* The words come first in the accessible name, because a bare argv
               is a thing to paste without understanding - and being able to
               decide NOT to run it is the point. */
            title={`${action.intent}\n\n${command}`}
            className="shrink-0 truncate font-mono text-[10px] text-ink-tertiary opacity-70"
          >
            {command}
          </span>
        );
      })()}

    </div>
  );
}
