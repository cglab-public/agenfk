/**
 * One animation clock for the whole rail (CGLAB 50878ebe).
 *
 * The spinner used to own its interval, so every running row ran its own
 * 80ms timer. `liveAgents.ts` had already argued against precisely that, in
 * its own header: "it needs a clock — and one clock for the whole board, not
 * one per card. A busy board with a timer each would wake the renderer
 * hundreds of times independently."
 *
 * The rail then did it per card. Twelve and a half state updates a second per
 * spinning row: ten sessions is 125 React renders a second, thirty — the app's
 * own cap — is 375, continuously, for as long as the window is in front. None
 * of it leaks, which is why this ranked below the findings that do. What it
 * costs instead is idle: the renderer never gets any, so V8's idle-time
 * collection never runs and the compositor stays awake, in an app whose
 * sessions are expected to last hours.
 *
 * A subscription rather than a hook, so the thing that matters — that there is
 * exactly ONE timer — can be tested directly instead of inferred from a
 * rendered component.
 *
 * Lockstep is a bonus, not a compromise: independent timers drifted apart and
 * a row of spinners span out of step. One clock makes several things working
 * at once look like several things working at once.
 */

/** The conventional spinner cadence. Slower reads as stuttering. */
export const FRAME_MS = 80;

/**
 * The frames themselves.
 *
 * Here rather than in the rail, because the counter and the glyphs are two
 * halves of one thing: a modulus larger than the array indexes past its end
 * and renders `undefined` into the row, and a smaller one silently drops
 * frames. Living in one file makes that impossible rather than merely tested.
 *
 * Braille dots because each is a single character, so a row does not reflow
 * as it spins.
 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** How many frames before the sequence repeats. Derived, never declared. */
export const FRAME_COUNT = SPINNER_FRAMES.length;

type Watcher = (frame: number) => void;

const watchers = new Set<Watcher>();
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function tick(): void {
  frame = (frame + 1) % FRAME_COUNT;
  // A copy, because a watcher may unsubscribe from inside its own callback —
  // React cleanups do — and mutating the set mid-iteration would skip the
  // watcher that follows it.
  for (const watcher of [...watchers]) {
    try {
      watcher(frame);
    } catch {
      /*
       * One row failing to render must not stop every other spinner on the
       * board. An unguarded loop would let a single throw escape into the
       * interval callback and take the clock with it.
       */
    }
  }
}

/**
 * Watch the frame counter. Returns an unsubscribe.
 *
 * The clock exists only while somebody is watching: it starts on the first
 * subscriber and stops on the last, the same lifecycle `LiveAgents` uses for
 * its sweep. An idle board runs no timers at all.
 */
export function subscribeToFrames(watcher: Watcher): () => void {
  watchers.add(watcher);
  if (!timer) timer = setInterval(tick, FRAME_MS);
  return () => {
    // Tracked rather than counted: a double unsubscribe — StrictMode
    // double-invokes cleanups, and callers are careless — must not stop a
    // clock that other rows still need. `Set.delete` is idempotent.
    watchers.delete(watcher);
    if (watchers.size > 0 || !timer) return;
    clearInterval(timer);
    timer = null;
  };
}
