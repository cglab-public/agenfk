/**
 * The command that would resolve this agent, computed and never run
 * (CGLAB-200).
 *
 * Today the screen shows a STATE and the person deduces the move. Showing the
 * literal argv removes the deduction without taking the decision away from
 * anybody - and a system that works out the right move, shows it, and waits is
 * auditable in a way that one which acts never is.
 *
 * NOTHING HERE EXECUTES. It returns strings. The caller renders them; a person
 * or a coordinating agent runs them.
 *
 * THE UNREACHABLE CASE IS THE REASON THIS NEEDED CGLAB-195 FIRST. For an agent
 * we cannot reach the move is to INSPECT - never to release, never to relaunch.
 * Absence authorises neither: releasing hands its files to somebody else while
 * it may still be writing them, and relaunching duplicates work that may still
 * be running. Without the middle state this module would have computed the
 * command for a finished agent and put it on screen, ready to be copied.
 */
import type { SessionState } from './sessionRow';

export interface NextAction {
  /** What this does, in words a person reads before the command. */
  readonly intent: string;
  /** The literal argv. Empty when there is nothing to suggest. */
  readonly argv: readonly string[];
  /**
   * True when the suggestion is about finding out rather than changing
   * anything. Rendered differently: it is safe, and saying so lowers the cost
   * of trying it.
   */
  readonly readOnly: boolean;
}

export interface NextActionInput {
  readonly itemId: string;
  readonly state: SessionState;
  /** Whether this app owns a terminal for it. A hook-recorded run does not. */
  readonly hasTerminal: boolean;
}

/** Nothing to suggest, and saying so beats inventing a plausible command. */
const NOTHING: NextAction = { intent: '', argv: [], readOnly: true };

/**
 * What to do about one agent.
 *
 * Returns ONE action, never a list. A row offering three commands makes the
 * reader choose between them, which is the deduction this exists to remove.
 */
export function nextAction({ itemId, state, hasTerminal }: NextActionInput): NextAction {
  const id = itemId.slice(0, 8);
  switch (state) {
    case 'unverifiable':
      /*
       * INSPECT, and only inspect. The record says running and we see nothing;
       * both of the tempting moves assert something we do not know. This is
       * read-only on purpose - the cheapest safe thing, so nobody reaches for
       * a destructive one to make the row go away.
       */
      return {
        intent: 'Cannot reach it. Look at what it last did before deciding anything.',
        argv: ['agenfk', 'get', id, '--json'],
        readOnly: true,
      };
    case 'failed':
      return {
        intent: 'It ended badly. Read the transcript, then decide whether to retry.',
        argv: hasTerminal
          ? ['agenfk', 'get', id, '--json']
          : ['agenfk', 'tokens', '--item', id],
        readOnly: true,
      };
    case 'blocked':
      /*
       * The one case where the move is not a command at all. A blocked agent
       * is waiting on its own prompt, in its own terminal, and suggesting a
       * CLI call here would send somebody to the wrong window.
       */
      return {
        intent: hasTerminal
          ? 'It is waiting on you. Open its terminal and answer.'
          : 'It is waiting on somebody, in a terminal this app does not own.',
        argv: [],
        readOnly: true,
      };
    case 'running':
    case 'idle':
      return NOTHING;
  }
}

/** The argv as one line, for a copy button. Empty when there is none. */
export function nextActionCommand(action: NextAction): string {
  return action.argv.join(' ');
}
