/**
 * Every agent you have running, in one rail (CGLAB-170).
 *
 * Replaces a hardcoded sentence in the sidebar footer. The design is the
 * CGLAB-170 artifact; what follows are the parts that are load-bearing rather
 * than decorative.
 *
 * **State is in the SHAPE, not only the colour.** These are 8px dots. Colour
 * alone fails outright for a colour-blind reader and in any greyscale
 * screenshot, so running is filled, waiting is a ring, idle is a thin ring, and
 * each also carries an aria-label.
 *
 * **Failures sort to the top.** A failure is the row that needs a person, and
 * burying it under three running agents is worse than not showing it — the
 * rail implies it is showing you what needs you.
 *
 * This used to claim a 'waiting' state as well. Nothing could produce one, so
 * the claim was documentation for behaviour that did not exist; see
 * PRODUCIBLE_STATES.
 */
import React from 'react';
import { clsx } from 'clsx';
import { AgentIcon } from './AgentIcon';
import { subscribeToFrames, SPINNER_FRAMES } from '../sharedTick';

export type SessionState = 'running' | 'blocked' | 'failed' | 'idle';

/**
 * The states something upstream can actually produce.
 *
 * A 'waiting' state used to live here too, sorted to the top, and the docblock
 * called it load-bearing. Nothing could ever build one: the shell emitted only
 * running or idle, and the rail's own tests handed the state directly to the
 * component — so they passed while the app could not reach it. A docblock
 * describing behaviour nobody can trigger is a lie that reads like
 * documentation, so it is gone rather than pretended.
 *
 * That day arrived, and it is called 'blocked' (CGLAB-193). The app can now
 * read a permission prompt off the rendered screen for the agents that draw
 * one, so the state has a producer and is back. It is still NOT guessed from
 * silence — an agent nobody can read stays unknown upstream and lands here as
 * idle, which is the old wrong answer rather than a new one.
 */
export const PRODUCIBLE_STATES: ReadonlySet<SessionState> = new Set(['running', 'blocked', 'failed', 'idle']);

export interface SessionRow {
  readonly runId: string;
  readonly itemId: string;
  /**
   * The card's project.
   *
   * Carried because revealing a card on the board has to bring its project
   * along — the board can only find a card belonging to the project it is
   * showing, so without this the reveal lands on the right tab and the wrong
   * list.
   */
  readonly projectId?: string;
  readonly title: string;
  readonly agentId: string;
  readonly agentLabel: string;
  readonly state: SessionState;
  /** The last run event, rendered as "Bash · npx vitest run". */
  readonly lastAction?: string;
  readonly startedAt: string;
  /**
   * Whether this app owns a PTY for it.
   *
   * False for a run recorded by the Claude Code hook: it has a transcript but
   * no terminal here, so the caller opens the read-only Runs view rather than
   * pretending to attach to a shell that does not exist.
   */
  readonly hasTerminal: boolean;
  /**
   * Whether this terminal's process has ended.
   *
   * Only meaningful with `hasTerminal`. It decides whether the row is shown at
   * all — see liveSessions — and the distinction it draws is ALIVE versus
   * DEAD, never idle versus running: a terminal sitting at a prompt is still a
   * session you can click into.
   */
  readonly exited?: boolean;
  /**
   * The hook's own verdict on the run: `running`, `done`, `failed`.
   *
   * Only for rows WITHOUT a terminal. It is the one trustworthy end marker
   * there is — the hook PATCHes it on Stop/SessionEnd — and liveSessions uses
   * it to drop a finished run instead of guessing from how long the card has
   * been quiet. Absent on older records, which is not the same as ended.
   */
  readonly runStatus?: string;
}

export interface SessionsRailProps {
  readonly rows: readonly SessionRow[];
  readonly onOpen: (row: SessionRow) => void;
  readonly onStop: (runId: string) => void;
  /**
   * Show this card on the board.
   *
   * A second affordance, not a replacement: the row's own click opens the
   * terminal, which is what was asked for. Without this there is no way to
   * reach the card at all, and the board's scroll-to-and-highlight became
   * unreachable code the day the row changed meaning.
   */
  readonly onReveal?: (row: SessionRow) => void;
}

/**
 * Failures first, then what is working, then what is quiet.
 *
 * A failure is the row that needs a person; burying it under three running
 * agents is worse than not showing it, because the rail implies it is showing
 * you what needs you.
 */
/*
 * Blocked sorts second, under failed and above running.
 *
 * Both of the top two are rows that need a PERSON. A failure needs one now; a
 * blocked agent needs one before it can move at all, and burying it under three
 * agents that are merrily working is exactly the burial this order exists to
 * prevent.
 */
const ORDER: Record<SessionState, number> = { failed: 0, blocked: 1, running: 2, idle: 3 };

/**
 * A spinner for running, a dot for everything else.
 *
 * A static dot only says "a session exists". The question the rail is there to
 * answer is "is it thinking right now" — and a spinner answers it at a glance,
 * which is the difference between looking at the sidebar and having to open the
 * terminal. Braille dots because they are a single character, so the row does
 * not reflow between states.
 */


function Spinner(): React.ReactElement {
  const [frame, setFrame] = React.useState(0);
  /*
   * One clock for every spinner, not one each.
   *
   * This used to own a `setInterval`, so a board with thirty running sessions
   * ran thirty timers and 375 React renders a second, continuously — which
   * `liveAgents.ts` had already argued against in its own header, two files
   * away. The shared tick is the same lifecycle that module uses: it exists
   * only while something is watching.
   *
   * It also makes the spinners turn in step with each other, which separate
   * timers could not: they drifted apart within seconds.
   */
  React.useEffect(() => subscribeToFrames(setFrame), []);
  return (
    <span
      data-testid="session-spinner"
      aria-hidden="true"
      className="mt-0.5 w-2 shrink-0 text-center font-mono text-[11px] leading-none text-emerald-400 motion-reduce:animate-none"
    >
      {/* Reduced motion gets a still frame rather than nothing: the row must
          not shift, and the state is still carried by data-state and the
          dot's aria-label. */}
      <span className="motion-reduce:hidden">{SPINNER_FRAMES[frame]}</span>
      <span className="hidden motion-reduce:inline">{SPINNER_FRAMES[0]}</span>
    </span>
  );
}

const DOT: Record<SessionState, string> = {
  running: 'bg-emerald-400',
  // A hollow ring rather than a filled dot: waiting is not a kind of running,
  // and the shape says so without relying on hue — these are drawn at 6px,
  // where colour is the weakest channel and fails outright for the ~8% of men
  // with a colour vision deficiency.
  blocked: 'border-2 border-amber-400',
  failed: 'bg-rose-400',
  idle: 'border border-ink-tertiary',
};

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Running',
  // "Waiting for you", not "Blocked": the point of the row is that it needs
  // something FROM THE READER, and a one-word status does not say that.
  blocked: 'Waiting for you',
  failed: 'Failed',
  idle: 'Idle',
};

/** Compact elapsed time. Seconds below a minute, then minutes, then hours. */
export function elapsedSince(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

export function SessionsRail({ rows, onOpen, onStop, onReveal }: SessionsRailProps): React.ReactElement {
  const ordered = React.useMemo(
    () => [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state]),
    [rows],
  );
  const runningCount = rows.filter(r => r.state === 'running').length;

  if (rows.length === 0) {
    return (
      <p className="px-2 pb-1 text-[11px] leading-snug text-ink-tertiary">
        None running. Starting an agent on a card shows it here.
      </p>
    );
  }

  return (
    <>
      {runningCount > 0 && (
        <div
          data-testid="sessions-count"
          className="px-2 pb-1 font-mono text-[9px] font-semibold tracking-wide text-brand"
        >
          {runningCount} running
        </div>
      )}
      <ul className="flex flex-col gap-px px-1.5 pb-2">
        {ordered.map(row => (
          <li key={row.runId} className="group relative">
            <button
              onClick={() => onOpen(row)}
              title={row.title}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-canvas"
            >
              {row.state === 'running' ? (
                <>
                  <Spinner />
                  {/* State still lives on a static node, so assistive tech and
                      any test can read it without depending on animation. */}
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
                  className={clsx('mt-1 h-2 w-2 shrink-0 rounded-full', DOT[row.state])}
                />
              )}
              <span className="min-w-0 flex-1">
                <span
                  data-testid="session-title"
                  className="block truncate text-[12px] leading-tight text-ink-secondary"
                >
                  {row.title}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 overflow-hidden font-mono text-[9.5px] text-ink-tertiary">
                  <AgentIcon agentId={row.agentId} size={10} />
                  <span className="shrink-0 font-semibold text-ink-secondary">{row.agentLabel}</span>
                  {row.lastAction && (
                    <>
                      <span className="opacity-40">·</span>
                      {/* What it is doing right now. The difference between a
                          status light and knowing whether to step in. */}
                      <span className="truncate">{row.lastAction}</span>
                    </>
                  )}
                </span>
              </span>
              {/* No elapsed time here any more.
                  The BOARD button is absolutely positioned in this same
                  corner, so on hover the two were drawn on top of each other —
                  "19hBOARD" on screen. Asked which to keep, the answer was the
                  button: how long a terminal has been open is not something
                  anyone acts on, and overlapping text reads as a broken app
                  rather than as a crowded one.

                  `elapsedSince` stays exported and tested — the Runs view uses
                  it, where a duration IS the point. */}
            </button>

            {onReveal && (
              <button
                onClick={event => {
                  // The row behind opens a terminal; this must not.
                  event.stopPropagation();
                  onReveal(row);
                }}
                aria-label={`Show ${row.title} on the board`}
                title="Show on the board"
                className="absolute right-2 top-1.5 font-mono text-[9px] tracking-wide text-ink-tertiary opacity-0 transition-opacity hover:text-brand focus:opacity-100 group-hover:opacity-100"
              >
                BOARD
              </button>
            )}

            {/* Only where there is something of ours to stop. A row recorded
                by the hook has a transcript and no PTY here, so its STOP did
                nothing at all — silently, which reads as the app ignoring you.
                Offering no button is the honest version. */}
            {row.hasTerminal && row.state === 'running' && (
              <button
                onClick={event => {
                  // Without this the click also reaches the row behind, so
                  // stopping an agent would navigate you into the terminal you
                  // just killed.
                  event.stopPropagation();
                  onStop(row.runId);
                }}
                aria-label={`Stop ${row.title}`}
                className="absolute bottom-1.5 right-2 font-mono text-[9px] tracking-wide text-ink-tertiary opacity-0 transition-opacity hover:text-rose-400 focus:opacity-100 group-hover:opacity-100"
              >
                STOP
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
