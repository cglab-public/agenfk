/**
 * How a session's state is DRAWN and NAMED, in one place.
 *
 * These four lived inside SessionsRail, which was fine while the rail was the
 * only thing that drew a session. It is not: processes are moving under the
 * card they belong to (1a1b8df6), and the rail is on its way out.
 *
 * Copying them into the new row would have been faster and would have created
 * exactly the defect this epic keeps producing - two renderings of one fact,
 * agreeing until somebody edits one of them. So they move here and both
 * callers import them. There is no second copy to drift.
 *
 * The reasoning behind each choice is kept with the value rather than
 * summarised, because the reasoning is the part that stops someone "tidying"
 * a hollow ring into a filled dot.
 */
import React from 'react';
import { subscribeToFrames, SPINNER_FRAMES } from '../sharedTick';
import type { SessionState } from './SessionsRail';

/**
 * Failures first, then what needs a person, then what is working, then quiet.
 *
 * A failure is the row that needs somebody; burying it under three running
 * agents is worse than not showing it at all, because a list that claims to
 * show what needs you and does not is a list you stop trusting. Blocked sorts
 * second for the same reason: it cannot move until a person arrives.
 */
export const ORDER: Record<SessionState, number> = { failed: 0, blocked: 1, running: 2, idle: 3 };

export const DOT: Record<SessionState, string> = {
  running: 'bg-emerald-400',
  // A hollow ring rather than a filled dot: waiting is not a kind of running,
  // and the shape says so without relying on hue - these are drawn at 6px,
  // where colour is the weakest channel and fails outright for the ~8% of men
  // with a colour vision deficiency.
  blocked: 'border-2 border-amber-400',
  failed: 'bg-rose-400',
  idle: 'border border-ink-tertiary',
};

export const STATE_LABEL: Record<SessionState, string> = {
  running: 'Running',
  // "Waiting for you", not "Blocked": the point of the row is that it needs
  // something FROM THE READER, and a one-word status does not say that.
  blocked: 'Waiting for you',
  failed: 'Failed',
  idle: 'Idle',
};

/**
 * A spinner for running, a still mark for everything else.
 *
 * A static dot only says "a session exists". The question the sidebar is there
 * to answer is "is it thinking right now", and a spinner answers it at a
 * glance - the difference between looking at the sidebar and having to open
 * the terminal. Braille dots because each is a single character, so the row
 * does not reflow as the frame changes.
 */
export function Spinner(): React.ReactElement {
  const [frame, setFrame] = React.useState(0);
  /*
   * One clock for every spinner, not one each.
   *
   * This used to own a `setInterval`, so thirty running sessions meant thirty
   * timers and hundreds of React renders a second, continuously. The shared
   * tick exists only while something is watching, and it also makes the
   * spinners turn in step - separate timers drifted apart within seconds.
   */
  React.useEffect(() => subscribeToFrames(setFrame), []);
  return (
    <span
      data-testid="session-spinner"
      aria-hidden="true"
      className="mt-0.5 w-2 shrink-0 text-center font-mono text-[11px] leading-none text-emerald-400 motion-reduce:animate-none"
    >
      {/* Reduced motion gets a still frame rather than nothing: the row must
          not shift, and the state is carried by data-state and the label
          regardless. */}
      <span className="motion-reduce:hidden">{SPINNER_FRAMES[frame]}</span>
      <span className="hidden motion-reduce:inline">{SPINNER_FRAMES[0]}</span>
    </span>
  );
}
